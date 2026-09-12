import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createCacheSaveWarningReporter,
  createDynamicCopilotModels,
  reconcileCopilotSelection,
} from "../extensions/dynamic-copilot-models.js";
import { CACHE_VERSION, getCredentialFingerprint, saveCatalogCache } from "../src/cache.js";
import type { CopilotCatalog } from "../src/catalog.js";

const credential = { type: "api_key" as const, key: "test-copilot-token" };

function catalogItem(id: string, contextWindow: number, maxTokens = 16_384) {
  return {
    id,
    name: id,
    model_picker_enabled: true,
    policy: { state: "enabled" },
    capabilities: {
      family: id,
      limits: { max_context_window_tokens: contextWindow, max_output_tokens: maxTokens },
      supports: { tool_calls: true, vision: false },
    },
  };
}

function fakeModel(id: string, contextWindow: number): Model<"openai-responses"> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.enterprise.githubcopilot.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 16_384,
  };
}

test("reconciles replaced objects and removed variants through pi.setModel", async () => {
  const old = fakeModel("gpt-test", 128_000);
  const replacement = fakeModel("gpt-test", 400_000);
  const canonical = fakeModel("gpt-test", 200_000);
  const removedVariant = fakeModel("gpt-test-1.0M", 1_000_000);
  let active: Model<Api> | undefined = old;
  let published: Model<Api>[] = [replacement];
  const selections: Model<Api>[] = [];
  const ctx = {
    get model() { return active; },
    modelRegistry: {
      find: (_provider: string, id: string) => published.find((model) => model.id === id),
      getAvailable: () => published,
      getAll: () => published,
    },
  };
  const pi = {
    setModel: async (model: Model<Api>) => {
      selections.push(model);
      active = model;
      return true;
    },
  };

  const replaced = await reconcileCopilotSelection(pi as Pick<ExtensionAPI, "setModel">, ctx as never, old);
  assert.deepEqual(replaced, { status: "replaced", model: replacement });
  assert.strictEqual(active, replacement);

  active = removedVariant;
  published = [canonical];
  const fallback = await reconcileCopilotSelection(
    pi as Pick<ExtensionAPI, "setModel">,
    ctx as never,
    removedVariant,
    { canonicalModelId: canonical.id },
  );
  assert.deepEqual(fallback, { status: "fallback", model: canonical });
  assert.strictEqual(active, canonical);
  assert.deepEqual(selections, [replacement, canonical]);
});

test("session_start and manual refresh replace stale active model objects after a cache-version miss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-extension-"));
  const cachePath = join(directory, "dynamic-copilot-models.json");
  const fingerprint = getCredentialFingerprint(credential);
  await writeFile(cachePath, JSON.stringify({
    version: CACHE_VERSION - 1,
    credentialFingerprint: fingerprint,
    models: [],
  }));

  const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  let provider: Provider<any> | undefined;
  let active: Model<Api> | undefined;
  const selections: Model<Api>[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  let payload: { data: unknown[] } = { data: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const pi = {
    registerProvider(value: Provider<any>) { provider = value; },
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    async setModel(model: Model<Api>) {
      selections.push(model);
      active = model;
      return true;
    },
  };

  try {
    await createDynamicCopilotModels({ agentDir: directory, credential })(pi as unknown as ExtensionAPI);
    assert.ok(provider);
    const initial = provider.getModels()[0] as Model<Api>;
    active = initial;
    payload = { data: [catalogItem(initial.id, initial.contextWindow + 10_000, initial.maxTokens)] };

    const modelRegistry = {
      async refresh(options: { force?: boolean; signal?: AbortSignal }) {
        assert.ok(provider?.refreshModels);
        await provider.refreshModels({
          credential,
          stored: undefined,
          allowNetwork: true,
          force: options.force,
          signal: options.signal ?? new AbortController().signal,
          publish: async (publication) => {
            publication.update?.();
            return true;
          },
        });
        return { aborted: false, errors: new Map<string, Error>() };
      },
      getAll: () => [...(provider?.getModels() ?? [])],
      getAvailable: () => [...(provider?.getModels() ?? [])],
      find: (providerId: string, id: string) => provider?.getModels().find((model) => model.provider === providerId && model.id === id),
    };
    const ctx = {
      get model() { return active; },
      modelRegistry,
      hasUI: true,
      ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
    };

    const sessionStart = handlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    await sessionStart({ type: "session_start", reason: "startup" }, ctx);
    const afterStartup = active;
    assert.ok(afterStartup);
    assert.notStrictEqual(afterStartup, initial);
    assert.strictEqual(afterStartup, modelRegistry.find(afterStartup.provider, afterStartup.id));
    assert.equal(afterStartup.contextWindow, initial.contextWindow + 10_000);

    payload = { data: [catalogItem(afterStartup.id, afterStartup.contextWindow + 20_000, afterStartup.maxTokens)] };
    const refresh = commands.get("copilot-models-refresh");
    assert.ok(refresh);
    await refresh.handler("", ctx);
    assert.ok(active);
    assert.notStrictEqual(active, afterStartup);
    assert.strictEqual(active, modelRegistry.find(active.provider, active.id));
    assert.equal(active.contextWindow, afterStartup.contextWindow + 20_000);
    assert.equal(selections.length, 2);
    assert.equal(notices.some(({ message }) => /no longer available/.test(message)), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("session_start deliberately falls back when a cached synthetic variant was removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-extension-"));
  const canonical = fakeModel("gpt-removed-test", 200_000);
  const variant = fakeModel("gpt-removed-test-1.0M", 1_000_000);
  const cached: CopilotCatalog = {
    models: [canonical, variant],
    routes: new Map([
      [canonical.id, { canonicalModelId: canonical.id, contextTier: "default" }],
      [variant.id, { canonicalModelId: canonical.id, contextTier: "long_context" }],
    ]),
  };
  await saveCatalogCache(cached, getCredentialFingerprint(credential), join(directory, "dynamic-copilot-models.json"));

  let provider: Provider<any> | undefined;
  let active: Model<Api> | undefined;
  let sessionStart: ((event: unknown, ctx: any) => Promise<void>) | undefined;
  const warnings: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [catalogItem(canonical.id, canonical.contextWindow)] }), { status: 200 });
  const pi = {
    registerProvider(value: Provider<any>) { provider = value; },
    on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) {
      if (name === "session_start") sessionStart = handler;
    },
    registerCommand() {},
    async setModel(model: Model<Api>) { active = model; return true; },
  };

  try {
    await createDynamicCopilotModels({ agentDir: directory, credential })(pi as unknown as ExtensionAPI);
    assert.ok(provider && sessionStart);
    active = provider.getModels().find((model) => model.id === variant.id);
    assert.ok(active);
    const registry = {
      async refresh() {
        await provider!.refreshModels!({
          credential,
          stored: undefined,
          allowNetwork: true,
          signal: new AbortController().signal,
          publish: async (publication) => { publication.update?.(); return true; },
        });
        return { aborted: false, errors: new Map<string, Error>() };
      },
      getAll: () => [...provider!.getModels()],
      getAvailable: () => [...provider!.getModels()],
      find: (providerId: string, id: string) => provider!.getModels().find((model) => model.provider === providerId && model.id === id),
    };
    const ctx = {
      get model() { return active; },
      modelRegistry: registry,
      hasUI: true,
      ui: { notify: (message: string) => warnings.push(message) },
    };
    await sessionStart!({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(active?.id, canonical.id);
    assert.strictEqual(active, registry.find("github-copilot", canonical.id));
    assert.equal(warnings.some((message) => message.includes(`${variant.id} is no longer available`)), true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("external catalog refresh keeps an old active synthetic route usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-extension-"));
  const canonicalId = "claude-refresh-test";
  const syntheticId = `${canonicalId}-300k`;
  const anthropic = (id: string, contextWindow: number): Model<"anthropic-messages"> => ({
    id,
    name: id,
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.enterprise.githubcopilot.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow,
    maxTokens: 100_000,
  });
  const oldCanonical = anthropic(canonicalId, 200_000);
  const oldSelected = anthropic(syntheticId, 300_000);
  await saveCatalogCache({
    models: [oldCanonical, oldSelected],
    routes: new Map([
      [canonicalId, { canonicalModelId: canonicalId, contextTier: "default" }],
      [syntheticId, { canonicalModelId: canonicalId, contextTier: "long_context" }],
    ]),
  }, getCredentialFingerprint(credential), join(directory, "dynamic-copilot-models.json"));

  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let provider: Provider<any> | undefined;
  const pi = {
    registerProvider(value: Provider<any>) { provider = value; },
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    registerCommand() {},
    async setModel() { return true; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{
      ...catalogItem(canonicalId, 300_000, 100_000),
      billing: { token_prices: {
        batch_size: 1_000_000,
        default: { context_max: 100_000 },
        long_context: { context_max: 200_000 },
      } },
    }],
  }), { status: 200 });

  try {
    await createDynamicCopilotModels({ agentDir: directory, credential })(pi as unknown as ExtensionAPI);
    assert.ok(provider?.refreshModels);
    const selected = provider.getModels().find((model) => model.id === syntheticId) as Model<"anthropic-messages">;
    assert.ok(selected, "startup cache supplies the active old object");

    // This is the independent refresh path used by pi's model picker: no
    // extension command/session reconciliation runs, and cancelling /model can
    // leave the old object selected.
    await provider.refreshModels({
      credential,
      stored: undefined,
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async (publication) => { publication.update?.(); return true; },
    });
    const replacement = provider.getModels().find((model) => model.id === syntheticId);
    assert.ok(replacement);
    assert.notStrictEqual(replacement, selected);

    const ctx = { model: selected };
    const request = { model: syntheticId, messages: [{ role: "user", content: "sanitized" }] };
    assert.deepEqual(handlers.get("before_provider_request")!({ payload: request }, ctx), {
      ...request,
      model: canonicalId,
    });

    const message = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "github-copilot",
      model: canonicalId,
      content: [{ type: "text", text: "sanitized" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    };
    const normalized = handlers.get("message_end")!({ message }, ctx);
    assert.equal(normalized.message.model, syntheticId);
    assert.equal(normalized.message.responseModel, canonicalId);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache save warnings are non-fatal and deduplicated", () => {
  const messages: string[] = [];
  const warn = createCacheSaveWarningReporter((message) => messages.push(message));
  warn(new Error("read-only filesystem"));
  warn(new Error("read-only filesystem"));
  warn(new Error("disk full"));
  assert.equal(messages.length, 2);
  assert.match(messages[0]!, /continuing without disk cache.*read-only filesystem/);
  assert.match(messages[1]!, /disk full/);
});
