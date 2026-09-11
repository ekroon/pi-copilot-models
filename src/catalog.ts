import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

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

export interface CopilotCatalogItem {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  model_picker_enabled?: unknown;
  policy?: unknown;
  capabilities?: {
    family?: unknown;
    limits?: CopilotModelLimits;
    supports?: CopilotModelSupports;
  } | null;
}

export interface CopilotCatalogResponse {
  data?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
  const available = new Set(efforts.filter((value): value is string => typeof value === "string"));
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

function toModel(
  item: CopilotCatalogItem & { id: string },
  modelsById: ReadonlyMap<string, Model<Api>>,
  baseUrl: string,
): Model<Api> {
  const template = findTemplate(item, modelsById);
  const api = template?.api ?? inferApi(item.id);
  const limits = item.capabilities?.limits;
  const efforts = item.capabilities?.supports?.reasoning_effort;
  const inferredThinking = inferThinkingLevelMap(efforts);
  const reasoning = Array.isArray(efforts) ? efforts.length > 0 : (template?.reasoning ?? false);
  const vision = item.capabilities?.supports?.vision;

  return {
    ...(template ?? {}),
    id: item.id,
    name: typeof item.name === "string" && item.name.length > 0 ? item.name : (template?.name ?? item.id),
    api,
    provider: "github-copilot",
    baseUrl: template?.baseUrl ?? baseUrl,
    reasoning,
    input: vision === true ? ["text", "image"] : vision === false ? ["text"] : (template?.input ?? ["text"]),
    cost: template?.cost ?? ZERO_COST,
    contextWindow: positiveInteger(limits?.max_context_window_tokens) ?? template?.contextWindow ?? 128_000,
    maxTokens: positiveInteger(limits?.max_output_tokens) ?? template?.maxTokens ?? 16_384,
    headers: template?.headers ?? COPILOT_HEADERS,
    thinkingLevelMap: template?.thinkingLevelMap ?? inferredThinking,
    compat: template?.compat ?? fallbackCompat(api),
  } as Model<Api>;
}

export function parseCopilotCatalog(
  payload: CopilotCatalogResponse,
  baseline: readonly Model<Api>[],
  baseUrl: string,
): Model<Api>[] {
  if (!Array.isArray(payload.data)) throw new Error("Invalid GitHub Copilot models response: expected data array");

  const modelsById = new Map(baseline.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const models: Model<Api>[] = [];

  for (const rawItem of payload.data) {
    const item = record(rawItem) as CopilotCatalogItem | undefined;
    if (!item || !isSelectable(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    models.push(toModel(item, modelsById, baseUrl));
  }

  return models;
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
