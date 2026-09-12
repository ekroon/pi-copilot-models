import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CopilotCatalog, CopilotModelRoute, CopilotModelRoutes } from "./catalog.js";

export const CACHE_VERSION = 6;
const CACHE_FILE = "dynamic-copilot-models.json";

interface CatalogCache {
  version: number;
  credentialFingerprint: string;
  inferenceBaseUrl: string;
  models: Model<Api>[];
  routes: Record<string, CopilotModelRoute>;
}

export interface CatalogCacheLoadOptions {
  /** Current credential-derived endpoint. It overrides stale cached model URLs. */
  inferenceBaseUrl?: string;
}

export function getCatalogCachePath(agentDir = getAgentDir()): string {
  if (!isAbsolute(agentDir)) {
    throw new Error(`Dynamic Copilot cache requires an absolute agentDir; received ${JSON.stringify(agentDir)}`);
  }
  return join(agentDir, CACHE_FILE);
}

/**
 * Bind catalogs to the stable secret that identifies the authenticated account.
 * The digest, never the credential itself, is persisted. Deliberately avoid the
 * rotating OAuth access token: a new refresh token safely causes a cache miss.
 */
export function getCredentialFingerprint(credential: unknown): string | undefined {
  if (credential === null || typeof credential !== "object") return undefined;
  const value = credential as Record<string, unknown>;
  const secret = value.type === "oauth" ? value.refresh : value.type === "api_key" ? value.key : undefined;
  if (typeof secret !== "string" || secret.length === 0) return undefined;
  return createHash("sha256").update(`${value.type}\0${secret}`).digest("hex");
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const SUPPORTED_APIS = new Set<Api>(["anthropic-messages", "openai-completions", "openai-responses"]);

function isSafeBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isCost(value: unknown): value is Model<Api>["cost"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const cost = value as Partial<Model<Api>["cost"]>;
  if (
    !isNonNegativeFinite(cost.input) ||
    !isNonNegativeFinite(cost.output) ||
    !isNonNegativeFinite(cost.cacheRead) ||
    !isNonNegativeFinite(cost.cacheWrite)
  ) return false;
  if (cost.tiers === undefined) return true;
  if (!Array.isArray(cost.tiers) || cost.tiers.length === 0) return false;

  let previousThreshold = -1;
  for (const rawTier of cost.tiers as unknown[]) {
    if (rawTier === null || typeof rawTier !== "object" || Array.isArray(rawTier)) return false;
    const tier = rawTier as Partial<Model<Api>["cost"]> & { inputTokensAbove?: unknown };
    if (
      typeof tier.inputTokensAbove !== "number" ||
      !Number.isSafeInteger(tier.inputTokensAbove) ||
      tier.inputTokensAbove < 0 ||
      tier.inputTokensAbove <= previousThreshold ||
      !isNonNegativeFinite(tier.input) ||
      !isNonNegativeFinite(tier.output) ||
      !isNonNegativeFinite(tier.cacheRead) ||
      !isNonNegativeFinite(tier.cacheWrite)
    ) return false;
    previousThreshold = tier.inputTokensAbove;
  }
  return true;
}

function isCachedModel(value: unknown): value is Model<Api> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Partial<Model<Api>>;
  return (
    typeof model.id === "string" &&
    model.id.length > 0 &&
    typeof model.name === "string" &&
    model.name.length > 0 &&
    model.provider === "github-copilot" &&
    typeof model.api === "string" &&
    SUPPORTED_APIS.has(model.api) &&
    isSafeBaseUrl(model.baseUrl) &&
    typeof model.reasoning === "boolean" &&
    Array.isArray(model.input) &&
    model.input.every((entry) => entry === "text" || entry === "image") &&
    isPositiveSafeInteger(model.contextWindow) &&
    isPositiveSafeInteger(model.maxTokens) &&
    isCost(model.cost)
  );
}

function isRoute(value: unknown): value is CopilotModelRoute {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Partial<CopilotModelRoute>;
  return (
    typeof route.canonicalModelId === "string" &&
    route.canonicalModelId.length > 0 &&
    (route.contextTier === "default" || route.contextTier === "long_context")
  );
}

function validatedRoutes(value: unknown, models: readonly Model<Api>[]): CopilotModelRoutes | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: [string, unknown][] = value instanceof Map
    ? [...value.entries()]
    : Object.keys(value).map((id) => {
        const source = value as Record<string, unknown>;
        return [id, Object.hasOwn(source, id) ? source[id] : undefined];
      });
  const modelIds = new Set(models.map((model) => model.id));
  if (modelIds.size !== models.length || entries.length !== models.length) return undefined;
  const routes = new Map<string, CopilotModelRoute>();
  for (const [id, route] of entries) {
    if (!modelIds.has(id) || !isRoute(route) || !modelIds.has(route.canonicalModelId)) return undefined;
    routes.set(id, Object.freeze({ ...route }));
  }
  for (const canonicalId of new Set([...routes.values()].map((route) => route.canonicalModelId))) {
    const canonicalRoute = routes.get(canonicalId);
    if (
      !canonicalRoute ||
      canonicalRoute.canonicalModelId !== canonicalId ||
      canonicalRoute.contextTier !== "default"
    ) return undefined;
  }
  return routes;
}

function serializeRoutes(routes: CopilotModelRoutes): Record<string, CopilotModelRoute> {
  const serialized = Object.create(null) as Record<string, CopilotModelRoute>;
  for (const [id, route] of routes) {
    if (Object.hasOwn(serialized, id)) throw new Error(`Duplicate Copilot model route: ${id}`);
    serialized[id] = route;
  }
  return serialized;
}

export function loadCatalogCache(
  credentialFingerprint: string | undefined,
  path = getCatalogCachePath(),
  options: CatalogCacheLoadOptions = {},
): CopilotCatalog | undefined {
  if (!credentialFingerprint) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CatalogCache>;
    if (parsed.version !== CACHE_VERSION || parsed.credentialFingerprint !== credentialFingerprint) return undefined;
    if (!Array.isArray(parsed.models) || parsed.models.length === 0 || !parsed.models.every(isCachedModel)) return undefined;

    const routes = validatedRoutes(parsed.routes, parsed.models);
    if (!routes) return undefined;

    const cachedBaseUrl = isSafeBaseUrl(parsed.inferenceBaseUrl) ? parsed.inferenceBaseUrl : undefined;
    if (!cachedBaseUrl || !parsed.models.every((model) => model.baseUrl === cachedBaseUrl)) return undefined;

    const inferenceBaseUrl = options.inferenceBaseUrl ?? cachedBaseUrl;
    if (!isSafeBaseUrl(inferenceBaseUrl)) return undefined;
    // Endpoint resolution is credential-specific and authoritative.
    const models = parsed.models.map((model) =>
      model.baseUrl === inferenceBaseUrl ? model : { ...model, baseUrl: inferenceBaseUrl },
    );
    return { models, routes };
  } catch {
    return undefined;
  }
}

export async function saveCatalogCache(
  catalog: Readonly<CopilotCatalog>,
  credentialFingerprint: string | undefined,
  path = getCatalogCachePath(),
): Promise<void> {
  if (!credentialFingerprint) return;
  if (catalog.models.length === 0 || !catalog.models.every(isCachedModel)) {
    throw new Error("Refusing to cache an invalid Copilot model catalog");
  }
  const inferenceBaseUrl = catalog.models[0]!.baseUrl;
  if (!catalog.models.every((model) => model.baseUrl === inferenceBaseUrl)) {
    throw new Error("Refusing to cache Copilot models with mixed inference base URLs");
  }
  const routes = validatedRoutes(catalog.routes, catalog.models);
  if (!routes) throw new Error("Refusing to cache invalid Copilot model routes");

  const payload: CatalogCache = {
    version: CACHE_VERSION,
    credentialFingerprint,
    inferenceBaseUrl,
    models: [...catalog.models],
    routes: serializeRoutes(routes),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
