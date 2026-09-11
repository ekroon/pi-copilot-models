import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CACHE_VERSION = 2;
const CACHE_FILE = "dynamic-copilot-models.json";

interface CatalogCache {
  version: number;
  credentialFingerprint: string;
  models: Model<Api>[];
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

function isCachedModel(value: unknown): value is Model<Api> {
  if (value === null || typeof value !== "object") return false;
  const model = value as Partial<Model<Api>>;
  return (
    typeof model.id === "string" &&
    model.id.length > 0 &&
    model.provider === "github-copilot" &&
    typeof model.api === "string" &&
    typeof model.baseUrl === "string" &&
    typeof model.reasoning === "boolean" &&
    Array.isArray(model.input) &&
    typeof model.contextWindow === "number" &&
    typeof model.maxTokens === "number"
  );
}

export function loadCatalogCache(
  credentialFingerprint: string | undefined,
  path = getCatalogCachePath(),
): Model<Api>[] | undefined {
  if (!credentialFingerprint) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CatalogCache>;
    if (parsed.version !== CACHE_VERSION || parsed.credentialFingerprint !== credentialFingerprint) return undefined;
    if (!Array.isArray(parsed.models) || parsed.models.length === 0 || !parsed.models.every(isCachedModel)) return undefined;
    return parsed.models;
  } catch {
    return undefined;
  }
}

export async function saveCatalogCache(
  models: readonly Model<Api>[],
  credentialFingerprint: string | undefined,
  path = getCatalogCachePath(),
): Promise<void> {
  if (!credentialFingerprint) return;
  const payload: CatalogCache = { version: CACHE_VERSION, credentialFingerprint, models: [...models] };
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
