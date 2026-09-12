import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { buildCopilotCatalog, formatTokens, getCopilotBaseUrl, parseCopilotCatalog } from "../src/catalog.js";

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

function tieredBilling(overrides: Record<string, unknown> = {}) {
  return {
    token_prices: {
      batch_size: 1_000_000,
      default: {
        context_max: 272_000,
        input_price: 200,
        output_price: 1_000,
        cache_price: 20,
        cache_write_price: 250,
      },
      long_context: {
        context_max: 922_000,
        input_price: 400,
        output_price: 1_500,
        cache_price: 40,
        cache_write_price: 500,
      },
      ...overrides,
    },
  };
}

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

test("uses the resolved account inference URL for known, cloned, and unknown models", () => {
  const proxyBaseUrl = getCopilotBaseUrl(
    { access: "tid=enterprise;proxy-ep=proxy.enterprise.githubcopilot.com;exp=123" },
    "https://api.individual.githubcopilot.com",
  );
  const catalog = buildCopilotCatalog(
    {
      data: [
        model("gpt-5.6-sol"),
        model("gpt-5.6-sol-fast"),
        model("entirely-new-family"),
      ],
    },
    [baseModel] as Model<Api>[],
    proxyBaseUrl,
  );

  assert.equal(proxyBaseUrl, "https://api.enterprise.githubcopilot.com");
  assert.deepEqual(new Set(catalog.models.map((entry) => entry.baseUrl)), new Set([proxyBaseUrl]));
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

test("generates default and long-context variants with explicit routes", () => {
  const catalog = buildCopilotCatalog(
    { data: [model("gpt-5.6-sol", { billing: tieredBilling() })] },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );

  assert.deepEqual(catalog.models.map(({ id, name, contextWindow }) => ({ id, name, contextWindow })), [
    { id: "gpt-5.6-sol", name: "gpt-5.6-sol · 400k", contextWindow: 400_000 },
    { id: "gpt-5.6-sol-1.1M", name: "gpt-5.6-sol · 1.1M", contextWindow: 1_050_000 },
  ]);
  assert.deepEqual(catalog.routes, new Map([
    ["gpt-5.6-sol", { canonicalModelId: "gpt-5.6-sol", contextTier: "default" }],
    ["gpt-5.6-sol-1.1M", { canonicalModelId: "gpt-5.6-sol", contextTier: "long_context" }],
  ]));
  assert.deepEqual(catalog.models[0]?.cost, baseModel.cost);
  assert.deepEqual(catalog.models[1]?.cost, { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 });
  assert.notStrictEqual(catalog.models[0]?.cost, catalog.models[1]?.cost);
});

test("publishes a default-only tier and calculates prompt plus output", () => {
  const billing = tieredBilling({ long_context: undefined });
  const catalog = buildCopilotCatalog(
    { data: [model("gpt-5.6-sol", { billing })] },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]?.contextWindow, 400_000);
  assert.equal(catalog.models[0]?.name, "gpt-5.6-sol · 400k");
});

test("preserves one-model behavior when billing or default context_max is unusable", () => {
  for (const billing of [
    undefined,
    null,
    {},
    { token_prices: "changed" },
    { token_prices: { default: {} } },
    { token_prices: { default: { context_max: -1 } } },
    { token_prices: { default: { context_max: 3.5 } } },
  ]) {
    const [parsed] = parseCopilotCatalog(
      { data: [model("gpt-5.6-sol", { billing })] },
      [baseModel] as Model<Api>[],
      "https://example.test",
    );
    assert.equal(parsed?.id, "gpt-5.6-sol");
    assert.equal(parsed?.contextWindow, 1_050_000);
    assert.equal(parsed?.name, "gpt-5.6-sol");
  }
});

test("skips only malformed additional tiers", () => {
  for (const long_context of [{}, { context_max: "922000" }, { context_max: Number.NaN }]) {
    const catalog = buildCopilotCatalog(
      { data: [model("gpt-5.6-sol", { billing: tieredBilling({ long_context }) })] },
      [baseModel] as Model<Api>[],
      "https://example.test",
    );
    assert.deepEqual(catalog.models.map((entry) => entry.id), ["gpt-5.6-sol"]);
    assert.equal(catalog.models[0]?.contextWindow, 400_000);
  }
});

test("caps effective context and skips a non-default tier with the same result", () => {
  const capped = model("gpt-5.6-sol", {
    billing: tieredBilling({
      default: { context_max: 400_000, input_price: 200, output_price: 1_000, cache_price: 20, cache_write_price: 250 },
      long_context: { context_max: 500_000, input_price: 400, output_price: 1_500, cache_price: 40, cache_write_price: 500 },
    }),
    capabilities: {
      limits: { max_context_window_tokens: 500_000, max_output_tokens: 128_000 },
      supports: { tool_calls: true },
    },
  });
  const catalog = buildCopilotCatalog({ data: [capped] }, [baseModel] as Model<Api>[], "https://example.test");
  assert.deepEqual(catalog.models.map((entry) => [entry.id, entry.contextWindow]), [["gpt-5.6-sol", 500_000]]);
});

test("uses footer-compatible context suffix formatting", () => {
  assert.equal(formatTokens(400_000), "400k");
  assert.equal(formatTokens(500_000), "500k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(1_050_000), "1.1M");
  assert.equal(formatTokens(9_500), "9.5k");
  assert.equal(formatTokens(999), "999");
});

test("supports prototype-named model IDs without route collisions", () => {
  const ids = ["__proto__", "constructor", "toString"];
  const catalog = buildCopilotCatalog(
    { data: ids.map((id) => model(id, { capabilities: { supports: { tool_calls: true } } })) },
    [],
    "https://example.test",
  );
  assert.deepEqual(catalog.models.map(({ id }) => id), ids);
  assert.deepEqual([...catalog.routes.keys()], ids);
  for (const id of ids) {
    assert.deepEqual(catalog.routes.get(id), { canonicalModelId: id, contextTier: "default" });
  }
});

test("canonical IDs win generated-alias collisions", () => {
  const catalog = buildCopilotCatalog(
    {
      data: [
        model("gpt-5.6-sol", { billing: tieredBilling() }),
        model("gpt-5.6-sol-1.1M", { capabilities: { supports: { tool_calls: true } } }),
      ],
    },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  assert.deepEqual(catalog.models.map((entry) => entry.id), [
    "gpt-5.6-sol",
    "gpt-5.6-sol@1.1M",
    "gpt-5.6-sol-1.1M",
  ]);
  assert.deepEqual(catalog.routes.get("gpt-5.6-sol@1.1M"), {
    canonicalModelId: "gpt-5.6-sol",
    contextTier: "long_context",
  });
  assert.deepEqual(catalog.routes.get("gpt-5.6-sol-1.1M"), {
    canonicalModelId: "gpt-5.6-sol-1.1M",
    contextTier: "default",
  });
});

test("converts cents per arbitrary batch size into dollars per million", () => {
  const halfBatchModel: Model<"openai-responses"> = {
    ...baseModel,
    cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  };
  const billing = tieredBilling({ batch_size: 500_000 });
  const catalog = buildCopilotCatalog(
    { data: [model("gpt-5.6-sol", { billing })] },
    [halfBatchModel] as Model<Api>[],
    "https://example.test",
  );
  assert.deepEqual(catalog.models[0]?.cost, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
  assert.deepEqual(catalog.models[1]?.cost, {
    input: 8,
    output: 30,
    cacheRead: 0.8,
    cacheWrite: 10,
  });
});

test("rejects malformed pricing and coherently falls back to inherited rates", () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "200", undefined]) {
    const defaultPrice = {
      context_max: 272_000,
      input_price: bad,
      output_price: 1_000,
      cache_price: 20,
      cache_write_price: 250,
    };
    const catalog = buildCopilotCatalog(
      { data: [model("gpt-5.6-sol", { billing: tieredBilling({ default: defaultPrice }) })] },
      [baseModel] as Model<Api>[],
      "https://example.test",
    );
    assert.deepEqual(catalog.models[0]?.cost, baseModel.cost);
    assert.deepEqual(catalog.models[1]?.cost, baseModel.cost);
  }
});

test("a malformed long price keeps both variant schedules on coherent inherited rates", () => {
  const long_context = {
    context_max: 922_000,
    input_price: 400,
    output_price: Number.POSITIVE_INFINITY,
    cache_price: 40,
    cache_write_price: 500,
  };
  const catalog = buildCopilotCatalog(
    { data: [model("gpt-5.6-sol", { billing: tieredBilling({ long_context }) })] },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.models[0]?.cost, baseModel.cost);
  assert.deepEqual(catalog.models[1]?.cost, baseModel.cost);
});

test("malformed batch_size keeps complete inherited schedules without hiding variants", () => {
  for (const batch_size of [0, -1, 1.5, "1000000", Number.POSITIVE_INFINITY]) {
    const catalog = buildCopilotCatalog(
      { data: [model("gpt-5.6-sol", { billing: tieredBilling({ batch_size }) })] },
      [baseModel] as Model<Api>[],
      "https://example.test",
    );
    assert.equal(catalog.models.length, 2);
    assert.deepEqual(catalog.models[0]?.cost, baseModel.cost);
    assert.deepEqual(catalog.models[1]?.cost, baseModel.cost);
  }
});

test("each variant has one complete flat schedule without inferred thresholds", () => {
  const catalog = buildCopilotCatalog(
    { data: [model("gpt-5.6-sol", { billing: tieredBilling() })] },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  assert.deepEqual(catalog.models[0]?.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  assert.deepEqual(catalog.models[1]?.cost, { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 });
  assert.equal(catalog.models.every((entry) => entry.cost.tiers === undefined), true);
});

test("equal tier prices still produce separate complete schedules", () => {
  const equalLong = {
    context_max: 922_000,
    input_price: 200,
    output_price: 1_000,
    cache_price: 20,
    cache_write_price: 250,
  };
  const catalog = buildCopilotCatalog(
    { data: [model("gpt-5.6-sol", { billing: tieredBilling({ long_context: equalLong }) })] },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  assert.deepEqual(catalog.models[1]?.cost, catalog.models[0]?.cost);
  assert.notStrictEqual(catalog.models[0]?.cost, catalog.models[1]?.cost);
  assert.equal(catalog.models[0]?.cost.tiers, undefined);
  assert.equal(catalog.models[1]?.cost.tiers, undefined);
});

test("rejects unrepresentable one-hour cache-write prices and non-finite conversions", () => {
  const representable = tieredBilling({
    default: {
      context_max: 272_000,
      input_price: 200,
      output_price: 1_000,
      cache_price: 20,
      cache_write_price: 250,
      cache_write_1h_price: 400,
    },
    long_context: {
      context_max: 922_000,
      input_price: 400,
      output_price: 1_500,
      cache_price: 40,
      cache_write_price: 500,
      cache_write_1h_price: 800,
    },
  });
  const accepted = buildCopilotCatalog(
    { data: [model("gpt-5.6-sol", { billing: representable })] },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  assert.deepEqual(accepted.models[0]?.cost, baseModel.cost);
  assert.deepEqual(accepted.models[1]?.cost, baseModel.cost);

  for (const cache_write_1h_price of [401, -1, Number.NaN, Number.POSITIVE_INFINITY, "400"]) {
    const defaultPrice = {
      context_max: 272_000,
      input_price: 200,
      output_price: 1_000,
      cache_price: 20,
      cache_write_price: 250,
      cache_write_1h_price,
    };
    const rejected = buildCopilotCatalog(
      { data: [model("gpt-5.6-sol", { billing: tieredBilling({ default: defaultPrice }) })] },
      [baseModel] as Model<Api>[],
      "https://example.test",
    );
    assert.deepEqual(rejected.models[0]?.cost, baseModel.cost);
    assert.deepEqual(rejected.models[1]?.cost, baseModel.cost);
  }

  const overflow = buildCopilotCatalog(
    {
      data: [
        model("gpt-5.6-sol", {
          billing: tieredBilling({
            batch_size: 1,
            default: {
              context_max: 272_000,
              input_price: Number.MAX_VALUE,
              output_price: Number.MAX_VALUE,
              cache_price: Number.MAX_VALUE,
              cache_write_price: Number.MAX_VALUE,
            },
          }),
        }),
      ],
    },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  assert.deepEqual(overflow.models[0]?.cost, baseModel.cost);
  assert.deepEqual(overflow.models[1]?.cost, baseModel.cost);
});

test("does not trust endpoint price units without a matching built-in anchor", () => {
  const catalog = buildCopilotCatalog(
    { data: [model("entirely-new-family", { billing: tieredBilling() })] },
    [],
    "https://example.test",
  );
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.models[0]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(catalog.models[1]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(catalog.models[0]?.api, "openai-completions");
});

test("validated units apply to unknown models while preserving conservative transport metadata", () => {
  const catalog = buildCopilotCatalog(
    {
      data: [
        model("gpt-5.6-sol", { billing: tieredBilling() }),
        model("entirely-new-family", { billing: tieredBilling() }),
      ],
    },
    [baseModel] as Model<Api>[],
    "https://example.test",
  );
  const unknown = catalog.models.find((entry) => entry.id === "entirely-new-family");
  const unknownLong = catalog.models.find((entry) => entry.id === "entirely-new-family-1.1M");
  assert.equal(unknown?.api, "openai-completions");
  assert.deepEqual(unknown?.compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  });
  assert.deepEqual(unknown?.cost, baseModel.cost);
  assert.deepEqual(unknownLong?.cost, { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 });
});
