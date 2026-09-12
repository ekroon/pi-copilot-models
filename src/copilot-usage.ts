import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type FetchFunction,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";

/** One AI credit is $0.01; Copilot reports costs in billionths of an AI credit. */
export const NANO_AIU_PER_USD = 100_000_000_000;

export interface CopilotTokenDetail {
  batchSize: number;
  costPerBatch: number;
  tokenCount: number;
  tokenType: string;
}

export interface CopilotUsage {
  totalNanoAiu?: number;
  tokenDetails?: CopilotTokenDetail[];
}

type Cost = AssistantMessage["usage"]["cost"];
type CostCategory = Exclude<keyof Cost, "total">;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseTokenDetail(value: unknown): CopilotTokenDetail | undefined {
  const detail = record(value);
  if (!detail) return undefined;
  const batchSize = positiveFinite(detail.batchSize ?? detail.batch_size);
  const costPerBatch = nonNegativeFinite(detail.costPerBatch ?? detail.cost_per_batch);
  const tokenCount = nonNegativeFinite(detail.tokenCount ?? detail.token_count);
  const tokenType = detail.tokenType ?? detail.token_type;
  if (batchSize === undefined || costPerBatch === undefined || tokenCount === undefined || typeof tokenType !== "string") {
    return undefined;
  }
  return { batchSize, costPerBatch, tokenCount, tokenType };
}

/** Parse either Copilot's wire shape or the camel-cased Copilot CLI event shape. */
export function parseCopilotUsage(value: unknown): CopilotUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;

  const totalNanoAiu = nonNegativeFinite(usage.totalNanoAiu ?? usage.total_nano_aiu);
  const rawDetails = usage.tokenDetails ?? usage.token_details;
  const tokenDetails = Array.isArray(rawDetails)
    ? rawDetails.map(parseTokenDetail).filter((detail): detail is CopilotTokenDetail => detail !== undefined)
    : undefined;

  if (totalNanoAiu === undefined && tokenDetails === undefined) return undefined;
  return {
    ...(totalNanoAiu !== undefined ? { totalNanoAiu } : {}),
    ...(tokenDetails !== undefined ? { tokenDetails } : {}),
  };
}

function findCopilotUsage(value: unknown, depth = 0): CopilotUsage | undefined {
  if (depth > 20) return undefined;
  const object = record(value);
  if (!object) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findCopilotUsage(item, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  for (const key of ["copilot_usage", "copilotUsage"] as const) {
    if (key in object) {
      const parsed = parseCopilotUsage(object[key]);
      if (parsed) return parsed;
    }
  }

  // Also accept the normalized object itself. This is useful for JSON event
  // transports that expose the CLI's camel-cased assistant.usage data.
  const direct = parseCopilotUsage(object);
  if (direct) return direct;

  for (const nested of Object.values(object)) {
    const found = findCopilotUsage(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Incrementally observes SSE, NDJSON, or ordinary JSON without changing the
 * bytes delivered to pi-ai's provider adapter.
 */
export class CopilotUsageParser {
  private readonly decoder = new TextDecoder();
  private readonly onUsage: (usage: CopilotUsage) => void;
  private buffer = "";
  private completeBody = "";
  private sseData: string[] = [];
  private sawSse = false;

  constructor(onUsage: (usage: CopilotUsage) => void) {
    this.onUsage = onUsage;
  }

  push(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sawSse) this.completeBody += text;
    this.buffer += text;
    this.processLines(false);
  }

  finish(): void {
    const tail = this.decoder.decode();
    if (!this.sawSse) this.completeBody += tail;
    this.buffer += tail;
    this.processLines(true);
    this.flushSseEvent();
    if (!this.sawSse) this.inspectJson(this.completeBody.trim());
    this.completeBody = "";
  }

  private processLines(flush: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.processLine(line);
    }
    if (flush && this.buffer.length > 0) {
      this.processLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
  }

  private processLine(line: string): void {
    if (line === "") {
      this.flushSseEvent();
      return;
    }
    if (line.startsWith("data:")) {
      this.sawSse = true;
      this.completeBody = "";
      this.sseData.push(line.slice(5).replace(/^ /, ""));
      return;
    }
    if (/^(?:event|id|retry):/.test(line) || line.startsWith(":")) return;
    this.inspectJson(line.trim());
  }

  private flushSseEvent(): void {
    if (this.sseData.length === 0) return;
    this.inspectJson(this.sseData.join("\n").trim());
    this.sseData = [];
  }

  private inspectJson(text: string): void {
    if (!text || text === "[DONE]") return;
    try {
      const usage = findCopilotUsage(JSON.parse(text));
      if (usage) this.onUsage(usage);
    } catch {
      // The provider still owns parsing and error handling. Observation must
      // never make an otherwise valid response fail.
    }
  }
}

class RequestUsageCapture {
  private generation = 0;
  private usage: CopilotUsage | undefined;

  beginResponse(): CopilotUsageParser {
    const generation = ++this.generation;
    this.usage = undefined;
    return new CopilotUsageParser((usage) => {
      if (generation !== this.generation) return;
      this.usage = {
        ...this.usage,
        ...usage,
      };
    });
  }

  apply(message: AssistantMessage): AssistantMessage {
    const captured = this.usage;
    // totalNanoAiu is the settled per-request value. Token details without that
    // total are not enough to establish that the response carried a complete
    // billing record, so retain Pi's fallback in that case.
    if (!captured || captured.totalNanoAiu === undefined) return message;

    const cost: Cost = { ...message.usage.cost };
    const categoryCosts = tokenDetailCosts(captured.tokenDetails);
    for (const category of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = categoryCosts[category];
      if (value !== undefined) cost[category] = value;
    }
    cost.total = captured.totalNanoAiu / NANO_AIU_PER_USD;

    return { ...message, usage: { ...message.usage, cost } };
  }
}

function tokenCategory(tokenType: string): CostCategory | undefined {
  switch (tokenType.toLowerCase().replaceAll("-", "_")) {
    case "input": return "input";
    case "output": return "output";
    case "cache_read": return "cacheRead";
    case "cache_write": return "cacheWrite";
    default: return undefined;
  }
}

/** Calculate known category costs; unknown future categories remain in the authoritative total only. */
export function tokenDetailCosts(details: readonly CopilotTokenDetail[] | undefined): Partial<Record<CostCategory, number>> {
  const costs: Partial<Record<CostCategory, number>> = {};
  for (const detail of details ?? []) {
    const category = tokenCategory(detail.tokenType);
    if (!category) continue;
    const nanoAiu = detail.tokenCount * detail.costPerBatch / detail.batchSize;
    if (!Number.isFinite(nanoAiu) || nanoAiu < 0) continue;
    costs[category] = (costs[category] ?? 0) + nanoAiu / NANO_AIU_PER_USD;
  }
  return costs;
}

function copyResponseWithBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  const copy = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // These informational properties are not accepted by ResponseInit, but some
  // clients inspect them. Preserve them where the runtime permits own props.
  for (const key of ["url", "redirected", "type"] as const) {
    try {
      Object.defineProperty(copy, key, { value: response[key], configurable: true });
    } catch {
      // Byte-for-byte body forwarding is the required behavior; metadata is
      // best effort across Fetch implementations.
    }
  }
  return copy;
}

function observingFetch(baseFetch: FetchFunction, capture: RequestUsageCapture): FetchFunction {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const parser = capture.beginResponse();
    if (!response.body) {
      parser.finish();
      return response;
    }

    const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try {
          parser.push(chunk);
        } catch {
          // Usage is optional. Never interfere with provider response parsing.
        }
        controller.enqueue(chunk);
      },
      flush() {
        try {
          parser.finish();
        } catch {
          // Usage is optional. Never interfere with provider response parsing.
        }
      },
    }));
    return copyResponseWithBody(response, observed);
  };
}

function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

function withTerminalMessage(event: AssistantMessageEvent, message: AssistantMessage): AssistantMessageEvent {
  if (event.type === "done") return { ...event, message };
  if (event.type === "error") return { ...event, error: message };
  return event;
}

function observeStream(
  source: AssistantMessageEventStream,
  capture: RequestUsageCapture,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        const terminal = terminalMessage(event);
        output.push(terminal ? withTerminalMessage(event, capture.apply(terminal)) : event);
      }
    } finally {
      output.end();
    }
  })();
  return output;
}

function wrapOptions<T extends StreamOptions | undefined>(
  options: T,
  capture: RequestUsageCapture,
): T {
  const baseFetch = options?.fetch ?? globalThis.fetch;
  return { ...options, fetch: observingFetch(baseFetch, capture) } as T;
}

/**
 * Decorate a provider without replacing any protocol adapter. Each invocation
 * owns its capture state, so concurrent requests and provider retries cannot
 * exchange billing data.
 */
export function withCopilotUsage<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
  return {
    ...provider,
    stream(model, context, options) {
      const capture = new RequestUsageCapture();
      return observeStream(provider.stream(model, context, wrapOptions(options, capture)), capture);
    },
    streamSimple(model, context, options) {
      const capture = new RequestUsageCapture();
      return observeStream(provider.streamSimple(model, context, wrapOptions(options, capture)), capture);
    },
  };
}
