import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { CopilotModelRoute, CopilotModelRoutes } from "../src/catalog.js";
import {
  CopilotRouteRegistry,
  normalizeCopilotAssistantMessage,
  transformCopilotHeaders,
  transformCopilotRequest,
} from "../src/request-routing.js";

const routes: CopilotModelRoutes = new Map([
  ["gpt-5.6-sol", { canonicalModelId: "gpt-5.6-sol", contextTier: "default" }],
  ["gpt-5.6-sol-1.1M", { canonicalModelId: "gpt-5.6-sol", contextTier: "long_context" }],
  ["claude-opus-4.7-1.0M", { canonicalModelId: "claude-opus-4.7", contextTier: "long_context" }],
]);
const route = (id: string): CopilotModelRoute | undefined => routes.get(id);

test("routes the default model explicitly to its canonical Copilot ID", () => {
  const payload = { model: "gpt-5.6-sol", input: "hello", stream: true };
  assert.deepEqual(transformCopilotRequest("github-copilot", "gpt-5.6-sol", payload, route("gpt-5.6-sol")), payload);
});

test("rewrites OpenAI Responses synthetic IDs without inventing a tier field", () => {
  const payload = {
    model: "gpt-5.6-sol-1.1M",
    input: [{ role: "user", content: "hello" }],
    reasoning: { effort: "high" },
    include: ["reasoning.encrypted_content"],
  };
  const transformed = transformCopilotRequest(
    "github-copilot",
    "gpt-5.6-sol-1.1M",
    payload,
    route("gpt-5.6-sol-1.1M"),
  ) as Record<string, unknown>;
  assert.deepEqual(transformed, { ...payload, model: "gpt-5.6-sol" });
  assert.equal("context_tier" in transformed, false);
  assert.equal("contextTier" in transformed, false);
  assert.equal(JSON.stringify(transformed).includes("gpt-5.6-sol-1.1M"), false);
});

test("rewrites OpenAI Chat Completions payloads and preserves unrelated fields", () => {
  const payload = {
    model: "gpt-5.6-sol-1.1M",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read" } }],
    stream_options: { include_usage: true },
    temperature: 0.25,
  };
  assert.deepEqual(
    transformCopilotRequest("github-copilot", "gpt-5.6-sol-1.1M", payload, route("gpt-5.6-sol-1.1M")),
    { ...payload, model: "gpt-5.6-sol" },
  );
  assert.equal(payload.model, "gpt-5.6-sol-1.1M", "the pure helper must not mutate its input");
});

test("rewrites Anthropic Messages payloads to the canonical model", () => {
  const payload = {
    model: "claude-opus-4.7-1.0M",
    system: [{ type: "text", text: "system" }],
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 1024,
    thinking: { type: "adaptive" },
  };
  assert.deepEqual(
    transformCopilotRequest("github-copilot", "claude-opus-4.7-1.0M", payload, route("claude-opus-4.7-1.0M")),
    { ...payload, model: "claude-opus-4.7" },
  );
});

test("leaves unknown Copilot models and malformed payloads untouched", () => {
  const unknown = { model: "future-model", input: "hello" };
  const noModel = { input: "hello" };
  assert.strictEqual(transformCopilotRequest("github-copilot", "future-model", unknown, undefined), unknown);
  assert.strictEqual(
    transformCopilotRequest("github-copilot", "gpt-5.6-sol-1.1M", noModel, route("gpt-5.6-sol-1.1M")),
    noModel,
  );
  assert.strictEqual(
    transformCopilotRequest("github-copilot", "gpt-5.6-sol-1.1M", null, route("gpt-5.6-sol-1.1M")),
    null,
  );
});

test("leaves every non-Copilot provider untouched even when an ID matches", () => {
  const payload = { model: "gpt-5.6-sol-1.1M", input: "hello" };
  assert.strictEqual(
    transformCopilotRequest("openai", "gpt-5.6-sol-1.1M", payload, route("gpt-5.6-sol-1.1M")),
    payload,
  );
});

test("rewrites only the selected synthetic ID and tolerates canonicalized or mismatched payloads", () => {
  const selectedRoute = route("gpt-5.6-sol-1.1M");
  const canonical = { model: "gpt-5.6-sol", input: "already transformed" };
  const mismatch = { model: "unrelated-model", input: "do not hijack" };
  const otherSynthetic = { model: "claude-opus-4.7-1.0M", input: "do not hijack" };
  assert.strictEqual(transformCopilotRequest("github-copilot", "gpt-5.6-sol-1.1M", canonical, selectedRoute), canonical);
  assert.strictEqual(transformCopilotRequest("github-copilot", "gpt-5.6-sol-1.1M", mismatch, selectedRoute), mismatch);
  assert.strictEqual(transformCopilotRequest("github-copilot", "gpt-5.6-sol-1.1M", otherSynthetic, selectedRoute), otherSynthetic);
});

test("catalog refresh preserves old object routes while assigning colliding new objects correctly", () => {
  const oldAlias = { id: "future-id", provider: "github-copilot", api: "openai-responses" } as Model<"openai-responses">;
  const futureCanonical = { id: "future-id", provider: "github-copilot", api: "openai-responses" } as Model<"openai-responses">;
  const registry = new CopilotRouteRegistry();
  registry.register([oldAlias], new Map([
    ["future-id", { canonicalModelId: "old-canonical", contextTier: "long_context" }],
  ]));
  // Pi's model override layer uses object spreads; the ownership marker must
  // survive that supported composition path while its catalog is current.
  const oldClone = { ...oldAlias };
  assert.deepEqual(registry.get(oldClone), { canonicalModelId: "old-canonical", contextTier: "long_context" });

  registry.register([futureCanonical], new Map([
    ["future-id", { canonicalModelId: "future-id", contextTier: "default" }],
  ]));
  const currentClone = { ...futureCanonical };

  assert.deepEqual(registry.get(oldAlias), { canonicalModelId: "old-canonical", contextTier: "long_context" });
  assert.deepEqual(registry.get(oldClone), { canonicalModelId: "old-canonical", contextTier: "long_context" });
  assert.deepEqual(registry.get(futureCanonical), { canonicalModelId: "future-id", contextTier: "default" });
  assert.deepEqual(registry.get(currentClone), { canonicalModelId: "future-id", contextTier: "default" });
});

test("normalizes finalized Anthropic messages for session restore and signed thinking replay", () => {
  const selected: Model<"anthropic-messages"> = {
    id: "claude-opus-4.7-1.0M",
    name: "Claude Opus 4.7 · 1.0M",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
  const finalized: AssistantMessage = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "github-copilot",
    model: "claude-opus-4.7",
    content: [{ type: "thinking", thinking: "signed thought", thinkingSignature: "opaque-signature" }],
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
  const selectedRoute = route(selected.id);
  const normalized = normalizeCopilotAssistantMessage(finalized, selected, selectedRoute);
  assert.equal(normalized.model, selected.id);
  assert.equal(normalized.responseModel, "claude-opus-4.7");
  assert.deepEqual(normalized.content, finalized.content);

  // Restoring the synthetic model and normalized session message makes pi-ai's
  // supported same-model replay path retain the opaque signature. Without the
  // normalization, transformMessages downgrades the thought to plain text.
  const restoredSelection = { ...selected };
  assert.deepEqual(transformMessages([normalized], restoredSelection)[0]?.content, finalized.content);
  assert.deepEqual(transformMessages([finalized], restoredSelection)[0]?.content, [
    { type: "text", text: "signed thought" },
  ]);
});

test("checked-in evidence contains structural source excerpts and disclaims absent captures", () => {
  const evidence = JSON.parse(readFileSync(
    new URL("../docs/evidence/copilot-cli-1.0.84-context-evidence.json", import.meta.url),
    "utf8",
  )) as any;

  assert.equal(evidence.copilotCliVersion, "1.0.84-4");
  assert.equal(Object.values(evidence.sources).every((source: any) => /^[a-f0-9]{64}$/.test(source.sha256)), true);
  assert.deepEqual(evidence.schemaExcerpts.ContextTier, {
    type: "string",
    enum: ["default", "long_context"],
    description: "Context tier for models that support multiple context-window sizes.",
  });
  assert.deepEqual(evidence.schemaExcerpts.ModelBillingTokenPrices.batchSize, {
    type: "integer",
    exclusiveMinimum: 0,
  });
  assert.match(evidence.schemaExcerpts.OptionsUpdateContextTier.description, /modelCapabilitiesOverrides/);
  assert.match(evidence.schemaExcerpts.ModelBillingTokenPrices.maxPromptTokens.description, /plus the model's max_output_tokens/);
  assert.match(evidence.runtimeExcerpts.cliContextOption, /choices\(\["default","long_context"\]\)/);
  assert.equal(evidence.requestEvidence.checkedInPairedStructuralCaptures, false);
  assert.equal(evidence.usageAndPricingEvidence.checkedInSanitizedObservations, false);
});

test("conservative routing preserves all request headers", () => {
  const headers = {
    Authorization: "Bearer redacted",
    "X-Client-Session-Id": "session",
    "Copilot-Integration-Id": "vscode-chat",
  };
  assert.strictEqual(transformCopilotHeaders(headers), headers);
  assert.deepEqual(transformCopilotHeaders(headers), headers);
  assert.equal(Object.keys(headers).some((name) => /context|tier/i.test(name)), false);
});
