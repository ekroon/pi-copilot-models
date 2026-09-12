import type { Api, Model, ModelCost, ModelThinkingLevel } from "@earendil-works/pi-ai";

export const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

const COPILOT_API_VERSION = "2026-06-01";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const STANDARD_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

interface CopilotModelLimits {
  max_context_window_tokens?: unknown;
  max_output_tokens?: unknown;
}

interface CopilotModelSupports {
  reasoning_effort?: unknown;
  tool_calls?: unknown;
  vision?: unknown;
}

export interface CopilotTokenPrice {
  context_max?: unknown;
  input_price?: unknown;
  output_price?: unknown;
  cache_price?: unknown;
  cache_write_price?: unknown;
  cache_write_1h_price?: unknown;
}

export interface CopilotTokenPrices {
  batch_size?: unknown;
  default?: CopilotTokenPrice | null;
  long_context?: CopilotTokenPrice | null;
}

export interface CopilotBilling {
  token_prices?: CopilotTokenPrices | null;
}

export interface CopilotCatalogItem {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  model_picker_enabled?: unknown;
  policy?: unknown;
  billing?: CopilotBilling | null;
  capabilities?: {
    family?: unknown;
    limits?: CopilotModelLimits;
    supports?: CopilotModelSupports;
  } | null;
}

export interface CopilotCatalogResponse {
  data?: unknown;
}

export type CopilotContextTierId = "default" | "long_context";

export interface CopilotContextTier {
  id: CopilotContextTierId;
  promptLimit: number;
  contextWindow: number;
  cost?: Model<Api>["cost"];
}

export interface CopilotModelRoute {
  canonicalModelId: string;
  contextTier: CopilotContextTierId;
}

export type CopilotModelRoutes = ReadonlyMap<string, CopilotModelRoute>;

export interface CopilotCatalog {
  models: Model<Api>[];
  routes: CopilotModelRoutes;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function policyState(item: CopilotCatalogItem): string | undefined {
  const state = record(item.policy)?.state;
  return typeof state === "string" ? state : undefined;
}

function isSelectable(item: CopilotCatalogItem): item is CopilotCatalogItem & { id: string } {
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.model_picker_enabled === true &&
    policyState(item) !== "disabled" &&
    item.capabilities?.supports?.tool_calls !== false
  );
}

function inferApi(id: string): Api {
  if (/^claude-(?:haiku|sonnet|opus)-/i.test(id)) return "anthropic-messages";
  if (/^(?:gpt-|grok-|mai-)/i.test(id)) return "openai-responses";
  return "openai-completions";
}

function templateCandidates(id: string, family: unknown): string[] {
  const values = [id];
  if (typeof family === "string") values.push(family);

  for (const value of [...values]) {
    values.push(
      value.replace(/-fast$/i, ""),
      value.replace(/-(?:preview|latest)$/i, ""),
      value.replace(/-(?:fast|preview|latest)(?:-\d+)?$/i, ""),
    );
  }
  return [...new Set(values.filter(Boolean))];
}

function commonPrefixScore(left: string, right: string): number {
  const a = left.split("-");
  const b = right.split("-");
  let score = 0;
  while (score < a.length && score < b.length && a[score] === b[score]) score++;
  return score;
}

function findTemplate(
  item: CopilotCatalogItem & { id: string },
  modelsById: ReadonlyMap<string, Model<Api>>,
): Model<Api> | undefined {
  for (const candidate of templateCandidates(item.id, item.capabilities?.family)) {
    const exact = modelsById.get(candidate);
    if (exact) return exact;
  }

  const expectedApi = inferApi(item.id);
  let best: Model<Api> | undefined;
  let bestScore = 0;
  for (const model of modelsById.values()) {
    if (model.api !== expectedApi) continue;
    const score = commonPrefixScore(item.id, model.id);
    if (score > bestScore) {
      best = model;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : undefined;
}

function inferThinkingLevelMap(efforts: unknown): Partial<Record<ModelThinkingLevel, string | null>> | undefined {
  if (!Array.isArray(efforts)) return undefined;
  const knownEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const available = new Set(
    efforts.filter((value): value is string => typeof value === "string" && knownEfforts.has(value)),
  );
  if (available.size === 0) return undefined;

  const result: Partial<Record<ModelThinkingLevel, string | null>> = Object.fromEntries(
    STANDARD_THINKING_LEVELS.map((level) => [level, null]),
  );

  result.off = available.has("none") ? "none" : null;
  result.minimal = available.has("minimal") ? "minimal" : available.has("low") ? "low" : null;
  for (const level of ["low", "medium", "high"] as const) {
    if (available.has(level)) result[level] = level;
  }
  for (const level of ["xhigh", "max"] as const) {
    if (available.has(level)) result[level] = level;
  }
  return result;
}

function fallbackCompat(api: Api): Model<Api>["compat"] {
  if (api === "openai-responses") return { supportsOpenAIGrammarTools: true };
  if (api === "openai-completions") {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    };
  }
  if (api === "anthropic-messages") return { supportsEagerToolInputStreaming: false };
  return undefined;
}

function toBaseModel(
  item: CopilotCatalogItem & { id: string },
  modelsById: ReadonlyMap<string, Model<Api>>,
  baseUrl: string,
): Model<Api> {
  const template = findTemplate(item, modelsById);
  const api = template?.api ?? inferApi(item.id);
  const limits = item.capabilities?.limits;
  const efforts = item.capabilities?.supports?.reasoning_effort;
  const inferredThinking = inferThinkingLevelMap(efforts);
  const reasoningExplicitlyDisabled = Array.isArray(efforts) && efforts.length === 0;
  const reasoning = reasoningExplicitlyDisabled
    ? false
    : inferredThinking
      ? true
      : (template?.reasoning ?? false);
  const thinkingLevelMap = reasoningExplicitlyDisabled
    ? undefined
    : (inferredThinking ?? template?.thinkingLevelMap);
  const vision = item.capabilities?.supports?.vision;

  return {
    ...(template ?? {}),
    id: item.id,
    name: typeof item.name === "string" && item.name.length > 0 ? item.name : (template?.name ?? item.id),
    api,
    provider: "github-copilot",
    // Authentication resolves the inference endpoint per Copilot account. A
    // built-in template contributes transport metadata, never its usually
    // individual-account URL (Enterprise/GHES/proxy accounts must not leak
    // back to that route).
    baseUrl,
    reasoning,
    input: vision === true ? ["text", "image"] : vision === false ? ["text"] : (template?.input ?? ["text"]),
    cost: template?.cost ?? ZERO_COST,
    contextWindow: positiveInteger(limits?.max_context_window_tokens) ?? template?.contextWindow ?? 128_000,
    maxTokens: positiveInteger(limits?.max_output_tokens) ?? template?.maxTokens ?? 16_384,
    headers: template?.headers ?? COPILOT_HEADERS,
    thinkingLevelMap,
    compat: template?.compat ?? fallbackCompat(api),
  } as Model<Api>;
}

/** Match pi's context footer formatter so generated IDs are immediately recognizable. */
export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function tokenPrices(item: CopilotCatalogItem): Record<string, unknown> | undefined {
  return record(record(item.billing)?.token_prices);
}

function parseTierPrice(value: unknown, batchSize: number): ModelCost | undefined {
  const price = record(value);
  if (!price) return undefined;
  const input = nonNegativeFinite(price.input_price);
  const output = nonNegativeFinite(price.output_price);
  const cacheRead = nonNegativeFinite(price.cache_price);
  const cacheWrite = nonNegativeFinite(price.cache_write_price);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;

  const convert = (raw: number): number | undefined => {
    const converted = (raw / 100) * (1_000_000 / batchSize);
    return nonNegativeFinite(converted);
  };
  const converted = {
    input: convert(input),
    output: convert(output),
    cacheRead: convert(cacheRead),
    cacheWrite: convert(cacheWrite),
  };
  if (
    converted.input === undefined ||
    converted.output === undefined ||
    converted.cacheRead === undefined ||
    converted.cacheWrite === undefined
  ) return undefined;

  // ModelCost cannot represent a separate one-hour cache-write rate. Without
  // reproducible usage evidence for a safe equivalence, reject that schedule
  // rather than silently folding it into another field.
  if ("cache_write_1h_price" in price) return undefined;
  return converted as ModelCost;
}

function sameRate(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(right)) * 1e-9;
}

function sameRates(left: ModelCost, right: ModelCost): boolean {
  return (["input", "output", "cacheRead", "cacheWrite"] as const).every((key) => sameRate(left[key], right[key]));
}

/**
 * The endpoint uses integer cents per `batch_size`. Only trust that conversion
 * after at least one exact built-in model in this response confirms all four
 * rates. This avoids silently applying a changed unit to the whole catalog.
 */
function endpointPriceUnitsValidated(
  items: readonly (CopilotCatalogItem & { id: string })[],
  modelsById: ReadonlyMap<string, Model<Api>>,
): boolean {
  for (const item of items) {
    const prices = tokenPrices(item);
    const batchSize = positiveInteger(prices?.batch_size);
    const template = modelsById.get(item.id);
    if (!batchSize || !template) continue;
    const converted = parseTierPrice(prices?.default, batchSize);
    if (converted && sameRates(converted, template.cost)) return true;
  }
  return false;
}

function parseTiers(
  item: CopilotCatalogItem,
  model: Model<Api>,
  pricesValidated: boolean,
): CopilotContextTier[] | undefined {
  const prices = tokenPrices(item);
  const tier = (id: CopilotContextTierId, raw: unknown): CopilotContextTier | undefined => {
    const value = record(raw);
    const promptLimit = positiveInteger(value?.context_max);
    if (!promptLimit) return undefined;
    return {
      id,
      promptLimit,
      contextWindow: Math.min(model.contextWindow, promptLimit + model.maxTokens),
    };
  };

  const defaultTier = tier("default", prices?.default);
  if (!defaultTier) return undefined;
  const longContext = tier("long_context", prices?.long_context);
  const hasDistinctLongContext = longContext && longContext.contextWindow !== defaultTier.contextWindow;

  const batchSize = positiveInteger(prices?.batch_size);
  if (pricesValidated && batchSize) {
    const defaultCost = parseTierPrice(prices?.default, batchSize);
    const longCost = hasDistinctLongContext ? parseTierPrice(prices?.long_context, batchSize) : undefined;
    // Publish endpoint pricing only when every generated variant has one
    // complete schedule. Selection-dependent or threshold billing has not been
    // independently substantiated here, so follow the plan's conservative
    // variant pricing and never synthesize pi cost tiers.
    if (defaultCost && (!hasDistinctLongContext || longCost)) {
      defaultTier.cost = defaultCost;
      if (hasDistinctLongContext && longCost) longContext.cost = longCost;
    }
  }

  return hasDistinctLongContext ? [defaultTier, longContext] : [defaultTier];
}

function uniqueAlias(
  canonicalId: string,
  formattedWindow: string,
  canonicalIds: ReadonlySet<string>,
  usedIds: ReadonlySet<string>,
): string {
  const preferred = `${canonicalId}-${formattedWindow}`;
  if (!canonicalIds.has(preferred) && !usedIds.has(preferred)) return preferred;
  const fallback = `${canonicalId}@${formattedWindow}`;
  if (!canonicalIds.has(fallback) && !usedIds.has(fallback)) return fallback;
  let sequence = 2;
  while (canonicalIds.has(`${fallback}-${sequence}`) || usedIds.has(`${fallback}-${sequence}`)) sequence++;
  return `${fallback}-${sequence}`;
}

export function buildCopilotCatalog(
  payload: CopilotCatalogResponse,
  baseline: readonly Model<Api>[],
  baseUrl: string,
): CopilotCatalog {
  if (!Array.isArray(payload.data)) throw new Error("Invalid GitHub Copilot models response: expected data array");

  const modelsById = new Map(baseline.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const items: (CopilotCatalogItem & { id: string })[] = [];
  for (const rawItem of payload.data) {
    const item = record(rawItem) as CopilotCatalogItem | undefined;
    if (!item || !isSelectable(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  const pricesValidated = endpointPriceUnitsValidated(items, modelsById);
  const canonicalIds = new Set(items.map((item) => item.id));
  const usedIds = new Set(canonicalIds);
  const models: Model<Api>[] = [];
  const routes = new Map<string, CopilotModelRoute>();

  for (const item of items) {
    const base = toBaseModel(item, modelsById, baseUrl);
    const tiers = parseTiers(item, base, pricesValidated);
    const defaultTier = tiers?.[0];
    const canonical = defaultTier
      ? {
          ...base,
          name: `${base.name} · ${formatTokens(defaultTier.contextWindow)}`,
          contextWindow: defaultTier.contextWindow,
          cost: defaultTier.cost ?? base.cost,
        }
      : base;
    models.push(canonical);
    routes.set(canonical.id, { canonicalModelId: item.id, contextTier: "default" });

    for (const tier of tiers?.slice(1) ?? []) {
      const formattedWindow = formatTokens(tier.contextWindow);
      const id = uniqueAlias(item.id, formattedWindow, canonicalIds, usedIds);
      usedIds.add(id);
      models.push({
        ...base,
        id,
        name: `${base.name} · ${formattedWindow}`,
        contextWindow: tier.contextWindow,
        cost: tier.cost ?? base.cost,
      });
      routes.set(id, { canonicalModelId: item.id, contextTier: tier.id });
    }
  }

  return { models, routes };
}

/** Backwards-compatible model-only parser for consumers that do not need routing. */
export function parseCopilotCatalog(
  payload: CopilotCatalogResponse,
  baseline: readonly Model<Api>[],
  baseUrl: string,
): Model<Api>[] {
  return buildCopilotCatalog(payload, baseline, baseUrl).models;
}

export function getCopilotBaseUrl(credential: unknown, defaultBaseUrl: string): string {
  const value = record(credential);
  const access = value?.access;
  const key = value?.key;
  const token = typeof access === "string" ? access : typeof key === "string" ? key : undefined;
  if (token) {
    const proxyHost = /(?:^|;)proxy-ep=([^;]+)/.exec(token)?.[1];
    if (proxyHost) return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
  }

  const enterprise = value?.enterpriseUrl;
  if (typeof enterprise === "string" && enterprise.trim()) {
    const input = enterprise.includes("://") ? enterprise : `https://${enterprise}`;
    try {
      return `https://copilot-api.${new URL(input).hostname}`;
    } catch {
      // Fall through to the provider's standard endpoint.
    }
  }
  return defaultBaseUrl;
}

export async function fetchCopilotCatalog(
  credential: unknown,
  defaultBaseUrl: string,
  signal: AbortSignal,
): Promise<CopilotCatalogResponse> {
  const value = record(credential);
  const token = typeof value?.access === "string" ? value.access : typeof value?.key === "string" ? value.key : undefined;
  if (!token) throw new Error("GitHub Copilot authentication is required; run /login github-copilot");

  const baseUrl = getCopilotBaseUrl(credential, defaultBaseUrl);
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...COPILOT_HEADERS,
      "X-GitHub-Api-Version": COPILOT_API_VERSION,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub Copilot model discovery failed: ${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as CopilotCatalogResponse;
}
