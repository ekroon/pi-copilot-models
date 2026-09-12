import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { CACHE_VERSION, getCatalogCachePath, getCredentialFingerprint, loadCatalogCache, saveCatalogCache } from "../src/cache.js";
import type { CopilotCatalog, CopilotModelRoute } from "../src/catalog.js";

function routeMap(entries: Record<string, CopilotModelRoute>) {
  return new Map(Object.entries(entries));
}

function serializedRoutes(routes: ReadonlyMap<string, CopilotModelRoute>) {
  return Object.fromEntries(routes);
}

const cachedModel: Model<"openai-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol · 400k",
  api: "openai-responses",
  provider: "github-copilot",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

const cachedLongModel: Model<"openai-responses"> = {
  ...cachedModel,
  id: "gpt-5.6-sol-264k",
  name: "GPT-5.6 Sol · 264k",
  contextWindow: 264_000,
  cost: {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 128_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
  },
};

const cachedCatalog: CopilotCatalog = {
  models: [cachedModel, cachedLongModel],
  routes: routeMap({
    "gpt-5.6-sol": { canonicalModelId: "gpt-5.6-sol", contextTier: "default" },
    "gpt-5.6-sol-264k": { canonicalModelId: "gpt-5.6-sol", contextTier: "long_context" },
  }),
};

test("uses pi's resolved agent directory for the catalog cache", () => {
  const agentDir = resolve(tmpdir(), "pi-agent");
  assert.equal(getCatalogCachePath(agentDir), join(agentDir, "dynamic-copilot-models.json"));
  assert.throws(() => getCatalogCachePath("~/.pi-sdk"), /absolute agentDir/);
  assert.throws(() => getCatalogCachePath("relative/pi-sdk"), /absolute agentDir/);
});

test("fingerprints stable account credentials without exposing them", () => {
  const first = getCredentialFingerprint({ type: "oauth", refresh: "account-a", access: "short-lived-a" });
  const refreshed = getCredentialFingerprint({ type: "oauth", refresh: "account-a", access: "short-lived-b" });
  const other = getCredentialFingerprint({ type: "oauth", refresh: "account-b", access: "short-lived-c" });
  assert.equal(first, refreshed);
  assert.notEqual(first, other);
  assert.equal(first?.includes("account-a"), false);
  assert.notEqual(getCredentialFingerprint({ type: "api_key", key: "environment-token" }), undefined);
  assert.equal(getCredentialFingerprint({ type: "oauth", access: "missing-refresh" }), undefined);
});

test("round-trips a dynamic catalog only for the matching account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "account-a" });
  const otherAccount = getCredentialFingerprint({ type: "oauth", refresh: "account-b" });
  try {
    await saveCatalogCache(cachedCatalog, account, path);
    assert.deepEqual(loadCatalogCache(account, path), cachedCatalog);
    assert.equal(loadCatalogCache(otherAccount, path), undefined);
    assert.equal(loadCatalogCache(undefined, path), undefined);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("round-trips prototype-named IDs through own serialized properties", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "hostile-id-account" });
  const ids = ["__proto__", "constructor", "toString"];
  const catalog: CopilotCatalog = {
    models: ids.map((id) => ({ ...cachedModel, id, name: id })),
    routes: new Map(ids.map((id) => [id, { canonicalModelId: id, contextTier: "default" as const }])),
  };
  try {
    await saveCatalogCache(catalog, account, path);
    const raw = JSON.parse(await readFile(path, "utf8")) as { routes: Record<string, unknown> };
    assert.deepEqual(Object.keys(raw.routes), ids);
    assert.equal(ids.every((id) => Object.hasOwn(raw.routes, id)), true);
    const loaded = loadCatalogCache(account, path);
    assert.deepEqual(loaded, catalog);
    assert.deepEqual([...loaded!.routes.keys()], ids);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores malformed, empty, and foreign-provider caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "account-a" });
  try {
    assert.equal(loadCatalogCache(account, path), undefined);
    for (const payload of [
      "not json",
      JSON.stringify({ version: CACHE_VERSION, credentialFingerprint: account, models: [], routes: {} }),
      JSON.stringify({
        version: CACHE_VERSION,
        credentialFingerprint: account,
        models: [{ ...cachedModel, provider: "openai" }],
        routes: serializedRoutes(cachedCatalog.routes),
      }),
      JSON.stringify({ version: 2, credentialFingerprint: account, models: cachedCatalog.models, routes: serializedRoutes(cachedCatalog.routes) }),
    ]) {
      await writeFile(path, payload);
      assert.equal(loadCatalogCache(account, path), undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsupported APIs, unsafe URLs, and malformed cost tiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "account-a" });
  const payload = (models: unknown[]) => ({
    version: CACHE_VERSION,
    credentialFingerprint: account,
    inferenceBaseUrl: cachedModel.baseUrl,
    models,
    routes: serializedRoutes(cachedCatalog.routes),
  });
  const replaceLong = (overrides: Record<string, unknown>) => [cachedModel, { ...cachedLongModel, ...overrides }];
  try {
    for (const models of [
      replaceLong({ api: "arbitrary-wire-api" }),
      replaceLong({ baseUrl: "not a url" }),
      replaceLong({ baseUrl: "file:///tmp/copilot" }),
      replaceLong({ baseUrl: "http://example.test" }),
      replaceLong({ baseUrl: "https://user:secret@example.test" }),
      replaceLong({ cost: { ...cachedLongModel.cost, tiers: "wrong" } }),
      replaceLong({ cost: { ...cachedLongModel.cost, tiers: [] } }),
      replaceLong({ cost: { ...cachedLongModel.cost, tiers: [{ inputTokensAbove: 1 }] } }),
      replaceLong({
        cost: {
          ...cachedLongModel.cost,
          tiers: [
            { inputTokensAbove: 10, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
            { inputTokensAbove: 10, input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
          ],
        },
      }),
      replaceLong({
        cost: {
          ...cachedLongModel.cost,
          tiers: [{ inputTokensAbove: 10, input: Number.POSITIVE_INFINITY, output: 1, cacheRead: 1, cacheWrite: 1 }],
        },
      }),
    ]) {
      await writeFile(path, JSON.stringify(payload(models)));
      assert.equal(loadCatalogCache(account, path), undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed, incomplete, and ambiguous route metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "account-a" });
  const base = {
    version: CACHE_VERSION,
    credentialFingerprint: account,
    inferenceBaseUrl: cachedModel.baseUrl,
    models: cachedCatalog.models,
  };
  try {
    for (const routes of [
      undefined,
      [],
      {},
      { ...serializedRoutes(cachedCatalog.routes), extra: { canonicalModelId: "extra", contextTier: "default" } },
      { ...serializedRoutes(cachedCatalog.routes), "gpt-5.6-sol-264k": { canonicalModelId: "missing", contextTier: "long_context" } },
      { ...serializedRoutes(cachedCatalog.routes), "gpt-5.6-sol-264k": { canonicalModelId: "gpt-5.6-sol", contextTier: "huge" } },
      { ...serializedRoutes(cachedCatalog.routes), "gpt-5.6-sol": { canonicalModelId: "gpt-5.6-sol", contextTier: "long_context" } },
    ]) {
      await writeFile(path, JSON.stringify({ ...base, routes }));
      assert.equal(loadCatalogCache(account, path), undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists and restores the single resolved account inference URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "enterprise-account" });
  const enterpriseUrl = "https://api.enterprise.githubcopilot.com";
  const enterpriseCatalog: CopilotCatalog = {
    models: cachedCatalog.models.map((model) => ({ ...model, baseUrl: enterpriseUrl })),
    routes: cachedCatalog.routes,
  };
  try {
    await saveCatalogCache(enterpriseCatalog, account, path);
    const raw = JSON.parse(await readFile(path, "utf8")) as { inferenceBaseUrl?: string };
    assert.equal(raw.inferenceBaseUrl, enterpriseUrl);
    assert.deepEqual(loadCatalogCache(account, path), enterpriseCatalog);

    await assert.rejects(
      saveCatalogCache({
        ...enterpriseCatalog,
        models: [enterpriseCatalog.models[0]!, { ...enterpriseCatalog.models[1]!, baseUrl: "https://api.individual.githubcopilot.com" }],
      }, account, path),
      /mixed inference base URLs/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats every legacy cache version as a normal miss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "enterprise-account" });
  const enterpriseUrl = "https://api.enterprise.githubcopilot.com";
  try {
    for (let version = 1; version < CACHE_VERSION; version++) {
      await writeFile(path, JSON.stringify({
        version,
        credentialFingerprint: account,
        inferenceBaseUrl: enterpriseUrl,
        models: cachedCatalog.models.map((model) => ({ ...model, baseUrl: enterpriseUrl })),
        routes: serializedRoutes(cachedCatalog.routes),
      }));
      assert.equal(
        loadCatalogCache(account, path, { inferenceBaseUrl: enterpriseUrl }),
        undefined,
        `cache v${version} must not be reconstructed`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomically replaces an existing catalog including its routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "account-a" });
  const replacement: CopilotCatalog = {
    models: [cachedModel],
    routes: new Map([["gpt-5.6-sol", cachedCatalog.routes.get("gpt-5.6-sol")!]]),
  };
  try {
    await saveCatalogCache(cachedCatalog, account, path);
    await saveCatalogCache(replacement, account, path);
    assert.deepEqual(loadCatalogCache(account, path), replacement);
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    assert.deepEqual(files, ["catalog.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
