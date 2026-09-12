import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  NANO_AIU_PER_USD,
  parseCopilotUsage,
  tokenDetailCosts,
  withCopilotUsage,
} from "../src/copilot-usage.js";

const fallbackCost = { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 };
const usageWire = {
  token_details: [
    { batch_size: 1_000_000, cost_per_batch: 250_000_000_000, token_count: 100_000, token_type: "input" },
    { batch_size: 1_000_000, cost_per_batch: 1_500_000_000_000, token_count: 20_000, token_type: "output" },
    { batch_size: 1_000_000, cost_per_batch: 25_000_000_000, token_count: 50_000, token_type: "cache_read" },
    { batch_size: 1_000_000, cost_per_batch: 100_000_000_000, token_count: 10_000, token_type: "future_category" },
  ],
  total_nano_aiu: 57_250_000_000,
};

function model(api: Api, id = `test-${api}`): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider: "github-copilot",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    contextWindow: 100_000,
    maxTokens: 1_000,
  };
}

function message(api: Api, id = `test-${api}`): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api,
    provider: "github-copilot",
    model: id,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      totalTokens: 180,
      cost: { ...fallbackCost },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function fragmentedResponse(body: string, fragmentSize = 7, status = 200): Response {
  const encoded = new TextEncoder().encode(body);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += fragmentSize) {
        controller.enqueue(encoded.slice(offset, offset + fragmentSize));
      }
      controller.close();
    },
  }), { status, headers: { "content-type": "text/event-stream" } });
}

function providerThatConsumesResponse(onBody?: (body: string) => void): Provider<Api> {
  const run = (selected: Model<Api>, _context: Context, options?: StreamOptions): AssistantMessageEventStream => {
    const events = createAssistantMessageEventStream();
    void (async () => {
      try {
        const response = await options!.fetch!("https://example.test/inference");
        const body = await response.text();
        onBody?.(body);
        const result = message(selected.api, selected.id);
        events.push({ type: "start", partial: result });
        events.push({ type: "done", reason: "stop", message: result });
      } catch (error) {
        const result = message(selected.api, selected.id);
        result.stopReason = "error";
        result.errorMessage = String(error);
        events.push({ type: "error", reason: "error", error: result });
      } finally {
        events.end();
      }
    })();
    return events;
  };

  return {
    id: "github-copilot",
    name: "GitHub Copilot",
    auth: { apiKey: { name: "test", resolve: async () => undefined } },
    getModels: () => [],
    stream: run,
    streamSimple: run,
  } as Provider<Api>;
}

const payloads: Array<{ api: Api; body: string }> = [
  {
    api: "openai-responses",
    body: `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { copilot_usage: usageWire } })}\n\n`,
  },
  {
    api: "openai-completions",
    body: `data: ${JSON.stringify({ choices: [], copilot_usage: usageWire })}\n\ndata: [DONE]\n\n`,
  },
  {
    api: "anthropic-messages",
    body: `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, copilot_usage: usageWire })}\n\n`,
  },
];

for (const method of ["stream", "streamSimple"] as const) {
  for (const { api, body } of payloads) {
    test(`${method} uses fragmented ${api} copilot_usage and forwards the response unchanged`, async () => {
      let forwarded = "";
      const provider = withCopilotUsage(providerThatConsumesResponse((value) => { forwarded = value; }));
      const selected = model(api);
      const result = await provider[method](selected, { messages: [] }, {
        fetch: async () => fragmentedResponse(body),
      }).result();

      assert.equal(forwarded, body);
      assert.deepEqual(result.usage.cost, {
        input: 0.25,
        output: 0.3,
        cacheRead: 0.0125,
        cacheWrite: fallbackCost.cacheWrite,
        total: 0.5725,
      });
    });
  }
}

test("observes a non-streaming JSON response", async () => {
  const body = JSON.stringify({ response: { copilot_usage: usageWire } }, null, 2);
  const provider = withCopilotUsage(providerThatConsumesResponse());
  const result = await provider.stream(model("openai-responses"), { messages: [] }, {
    fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  }).result();
  assert.equal(result.usage.cost.total, 0.5725);
});

test("accepts the Copilot CLI camel-cased usage shape", () => {
  assert.deepEqual(parseCopilotUsage({
    totalNanoAiu: 2_500_000_000,
    tokenDetails: [{ batchSize: 1_000, costPerBatch: 1_000_000_000, tokenCount: 5, tokenType: "input" }],
  }), {
    totalNanoAiu: 2_500_000_000,
    tokenDetails: [{ batchSize: 1_000, costPerBatch: 1_000_000_000, tokenCount: 5, tokenType: "input" }],
  });
  assert.equal(2_500_000_000 / NANO_AIU_PER_USD, 0.025);
});

test("unknown token categories affect only Copilot's authoritative total", () => {
  const costs = tokenDetailCosts(parseCopilotUsage(usageWire)?.tokenDetails);
  assert.deepEqual(costs, { input: 0.25, output: 0.3, cacheRead: 0.0125 });
});

test("concurrent requests keep capture state isolated", async () => {
  const provider = withCopilotUsage(providerThatConsumesResponse());
  const selected = model("openai-completions");
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const id = new URL(input instanceof Request ? input.url : input).searchParams.get("id");
    await new Promise((resolve) => setTimeout(resolve, id === "slow" ? 10 : 0));
    const total_nano_aiu = id === "slow" ? 1_000_000_000 : 9_000_000_000;
    return fragmentedResponse(`data: ${JSON.stringify({ copilot_usage: { total_nano_aiu } })}\n\n`, 3);
  };
  const request = (id: string) => provider.stream(selected, { messages: [] }, {
    fetch: () => fetch(`https://example.test/inference?id=${id}`),
  }).result();

  const [slow, fast] = await Promise.all([request("slow"), request("fast")]);
  assert.equal(slow.usage.cost.total, 0.01);
  assert.equal(fast.usage.cost.total, 0.09);
});

test("a retry uses only the final response's Copilot usage", async () => {
  let attempt = 0;
  const retrying = providerThatConsumesResponse();
  retrying.stream = (selected, _context, options) => {
    const events = createAssistantMessageEventStream();
    void (async () => {
      await (await options!.fetch!("https://example.test/attempt-1")).text();
      await (await options!.fetch!("https://example.test/attempt-2")).text();
      const result = message(selected.api, selected.id);
      events.push({ type: "done", reason: "stop", message: result });
      events.end();
    })();
    return events;
  };
  const provider = withCopilotUsage(retrying);
  const result = await provider.stream(model("openai-completions"), { messages: [] }, {
    fetch: async () => {
      attempt++;
      return fragmentedResponse(`data: ${JSON.stringify({
        copilot_usage: { total_nano_aiu: attempt === 1 ? 99_000_000_000 : 2_000_000_000 },
      })}\n\n`);
    },
  }).result();

  assert.equal(attempt, 2);
  assert.equal(result.usage.cost.total, 0.02);
});

test("missing or malformed Copilot usage preserves catalog-derived costs", async () => {
  for (const body of [
    `data: ${JSON.stringify({ usage: { prompt_tokens: 100 } })}\n\n`,
    `data: ${JSON.stringify({ copilot_usage: { total_nano_aiu: "invalid", token_details: "invalid" } })}\n\n`,
    `data: ${JSON.stringify({ copilot_usage: { token_details: usageWire.token_details } })}\n\n`,
    "not-json-at-all",
  ]) {
    const provider = withCopilotUsage(providerThatConsumesResponse());
    const result = await provider.stream(model("openai-completions"), { messages: [] }, {
      fetch: async () => fragmentedResponse(body, 2),
    }).result();
    assert.deepEqual(result.usage.cost, fallbackCost);
  }
});

test("sanitized live captures confirm nano-AIU totals and CLI conversion", async () => {
  const evidence = JSON.parse(await readFile(
    new URL("../docs/evidence/copilot-usage-contract.json", import.meta.url),
    "utf8",
  )) as {
    conversion: { nanoAiuPerAiCredit: number; usdPerAiCredit: number; nanoAiuPerUsd: number };
    captures: Array<{ copilot_usage: typeof usageWire; derived: { aiCredits: number; usd: number } }>;
    cliComparison: { displayedAiCredits: number; totalNanoAiu: number; derivedAiCredits: number; derivedUsd: number };
  };
  assert.equal(
    evidence.conversion.nanoAiuPerAiCredit / evidence.conversion.usdPerAiCredit,
    evidence.conversion.nanoAiuPerUsd,
  );
  for (const capture of evidence.captures) {
    const computed = capture.copilot_usage.token_details.reduce(
      (total, detail) => total + detail.token_count * detail.cost_per_batch / detail.batch_size,
      0,
    );
    assert.equal(computed, capture.copilot_usage.total_nano_aiu);
    assert.equal(capture.derived.aiCredits, computed / evidence.conversion.nanoAiuPerAiCredit);
    assert.equal(capture.derived.usd, computed / evidence.conversion.nanoAiuPerUsd);
  }
  assert.equal(
    evidence.cliComparison.derivedAiCredits,
    evidence.cliComparison.totalNanoAiu / evidence.conversion.nanoAiuPerAiCredit,
  );
  assert.equal(
    evidence.cliComparison.derivedUsd,
    evidence.cliComparison.totalNanoAiu / evidence.conversion.nanoAiuPerUsd,
  );
  assert.equal(evidence.cliComparison.displayedAiCredits, Number(evidence.cliComparison.derivedAiCredits.toFixed(2)));
});

test("a corrected terminal message remains corrected through JSON session persistence and aggregation", async () => {
  const provider = withCopilotUsage(providerThatConsumesResponse());
  const result = await provider.streamSimple(model("openai-responses"), { messages: [] }, {
    fetch: async () => fragmentedResponse(`data: ${JSON.stringify({ copilot_usage: usageWire })}\n\n`),
  }).result();

  const restored = JSON.parse(JSON.stringify({ type: "message", message: result })).message as AssistantMessage;
  const compactionUsage = JSON.parse(JSON.stringify(result.usage)) as AssistantMessage["usage"];
  const footerTotal = restored.usage.cost.total + compactionUsage.cost.total;
  assert.equal(restored.usage.cost.total, 0.5725);
  assert.equal(compactionUsage.cost.total, 0.5725);
  assert.equal(footerTotal, 1.145);
});
