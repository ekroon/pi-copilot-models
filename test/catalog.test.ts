import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getCopilotBaseUrl, parseCopilotCatalog } from "../src/catalog.js";

const baseModel: Model<"openai-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-responses",
  provider: "github-copilot",
  baseUrl: "https://api.individual.githubcopilot.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  compat: { supportsOpenAIGrammarTools: true },
};

function model(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    model_picker_enabled: true,
    policy: { state: "enabled" },
    capabilities: {
      family: id,
      limits: { max_context_window_tokens: 1_050_000, max_output_tokens: 128_000 },
      supports: {
        tool_calls: true,
        vision: true,
        reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    },
    ...overrides,
  };
}

test("discovers a new fast variant by cloning its nearest built-in model", () => {
  const models = parseCopilotCatalog(
    { data: [model("gpt-5.6-sol-fast", { name: "GPT-5.6 Sol Fast (Internal only)" })] },
    [baseModel] as Model<Api>[],
    "https://api.individual.githubcopilot.com",
  );

  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "gpt-5.6-sol-fast");
  assert.equal(models[0]?.api, "openai-responses");
  assert.deepEqual(models[0]?.compat, baseModel.compat);
  assert.deepEqual(models[0]?.cost, baseModel.cost);
  assert.equal(models[0]?.contextWindow, 1_050_000);
});

test("uses server limits and vision capability for known models", () => {
  const models = parseCopilotCatalog(
    {
      data: [
        model("gpt-5.6-sol", {
          capabilities: {
            limits: { max_context_window_tokens: 900_000, max_output_tokens: 64_000 },
            supports: { tool_calls: true, vision: false, reasoning_effort: ["low", "high"] },
          },
        }),
      ],
    },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );

  assert.equal(models[0]?.contextWindow, 900_000);
  assert.equal(models[0]?.maxTokens, 64_000);
  assert.deepEqual(models[0]?.input, ["text"]);
  assert.equal(models[0]?.reasoning, true);
  assert.deepEqual(models[0]?.thinkingLevelMap, {
    off: null,
    minimal: "low",
    low: "low",
    medium: null,
    high: "high",
  });
  assert.deepEqual(getSupportedThinkingLevels(models[0]!), ["minimal", "low", "high"]);
});

test("uses narrower server reasoning capabilities for cloned models", () => {
  const [parsed] = parseCopilotCatalog(
    {
      data: [
        model("gpt-5.6-sol-fast", {
          capabilities: { supports: { tool_calls: true, reasoning_effort: ["high"] } },
        }),
      ],
    },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );

  assert.ok(parsed);
  assert.deepEqual(parsed.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
  });
  assert.deepEqual(getSupportedThinkingLevels(parsed), ["high"]);
});

test("uses broader server reasoning capabilities for cloned models", () => {
  const narrowTemplate: Model<"openai-responses"> = {
    ...baseModel,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
  };
  const [parsed] = parseCopilotCatalog(
    { data: [model("gpt-5.6-sol-fast")] },
    [narrowTemplate] as Model<Api>[],
    "https://example.test",
  );

  assert.ok(parsed);
  assert.deepEqual(parsed.thinkingLevelMap, {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  assert.deepEqual(getSupportedThinkingLevels(parsed), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("falls back to template reasoning metadata when server metadata is missing or malformed", () => {
  for (const reasoningEffort of [undefined, "high", [42, "unknown"]]) {
    const supports: Record<string, unknown> = { tool_calls: true };
    if (reasoningEffort !== undefined) supports.reasoning_effort = reasoningEffort;
    const [parsed] = parseCopilotCatalog(
      {
        data: [model("gpt-5.6-sol-fast", { capabilities: { supports } })],
      },
      [baseModel] as Model<Api>[],
      "https://example.test",
    );

    assert.ok(parsed);
    assert.equal(parsed.reasoning, true);
    assert.deepEqual(parsed.thinkingLevelMap, baseModel.thinkingLevelMap);
    assert.deepEqual(getSupportedThinkingLevels(parsed), ["minimal", "low", "medium", "high", "xhigh", "max"]);
  }
});

test("an empty server reasoning array disables reasoning and clears inherited levels", () => {
  const [parsed] = parseCopilotCatalog(
    {
      data: [
        model("gpt-5.6-sol-fast", {
          capabilities: { supports: { tool_calls: true, reasoning_effort: [] } },
        }),
      ],
    },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );

  assert.ok(parsed);
  assert.equal(parsed.reasoning, false);
  assert.equal(parsed.thinkingLevelMap, undefined);
  assert.deepEqual(getSupportedThinkingLevels(parsed), ["off"]);
});

test("filters disabled, hidden, duplicate, and non-tool models", () => {
  const disabled = model("disabled", { policy: { state: "disabled" } });
  const hidden = model("hidden", { model_picker_enabled: false });
  const noTools = model("no-tools", {
    capabilities: { supports: { tool_calls: false } },
  });
  const valid = model("gpt-new");

  const models = parseCopilotCatalog(
    { data: [disabled, hidden, noTools, valid, valid] },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );

  assert.deepEqual(models.map((entry) => entry.id), ["gpt-new"]);
});

test("infers safe defaults for a completely unknown model", () => {
  const models = parseCopilotCatalog(
    { data: [model("gpt-7-new", { capabilities: { limits: {}, supports: { tool_calls: true, reasoning_effort: ["none", "high"] } } })] },
    [],
    "https://example.test",
  );

  assert.equal(models[0]?.api, "openai-responses");
  assert.equal(models[0]?.contextWindow, 128_000);
  assert.equal(models[0]?.maxTokens, 16_384);
  assert.deepEqual(models[0]?.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
  });
});

const thinkingLevelCases: Array<{
  efforts: string[];
  supported: ModelThinkingLevel[];
  map: Partial<Record<ModelThinkingLevel, string | null>>;
}> = [
  {
    efforts: ["none", "high"],
    supported: ["off", "high"],
    map: { off: "none", minimal: null, low: null, medium: null, high: "high" },
  },
  {
    efforts: ["high"],
    supported: ["high"],
    map: { off: null, minimal: null, low: null, medium: null, high: "high" },
  },
  {
    efforts: ["low", "high"],
    supported: ["minimal", "low", "high"],
    map: { off: null, minimal: "low", low: "low", medium: null, high: "high" },
  },
  {
    efforts: ["minimal", "high"],
    supported: ["minimal", "high"],
    map: { off: null, minimal: "minimal", low: null, medium: null, high: "high" },
  },
  {
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    supported: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    map: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
];

for (const { efforts, supported, map } of thinkingLevelCases) {
  test(`exposes only advertised reasoning efforts: ${efforts.join(", ")}`, () => {
    const [parsed] = parseCopilotCatalog(
      {
        data: [
          model("completely-unknown-model", {
            capabilities: { supports: { tool_calls: true, reasoning_effort: efforts } },
          }),
        ],
      },
      [],
      "https://example.test",
    );

    assert.ok(parsed);
    assert.deepEqual(getSupportedThinkingLevels(parsed), supported);
    assert.deepEqual(parsed.thinkingLevelMap, map);
  });
}

test("rejects malformed responses", () => {
  assert.throws(() => parseCopilotCatalog({}, [], "https://example.test"), /expected data array/);
});

test("derives individual, enterprise, and fallback endpoints", () => {
  assert.equal(
    getCopilotBaseUrl(
      { access: "tid=abc;proxy-ep=proxy.business.githubcopilot.com;exp=123" },
      "https://fallback.test",
    ),
    "https://api.business.githubcopilot.com",
  );
  assert.equal(
    getCopilotBaseUrl({ enterpriseUrl: "github.example.com" }, "https://fallback.test"),
    "https://copilot-api.github.example.com",
  );
  assert.equal(getCopilotBaseUrl({}, "https://fallback.test"), "https://fallback.test");
});
