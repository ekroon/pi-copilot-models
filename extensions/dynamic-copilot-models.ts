import type { Model, Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { getAgentDir, readStoredCredential, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fetchCopilotCatalog, getCopilotBaseUrl, parseCopilotCatalog } from "../src/catalog.js";
import { getCatalogCachePath, getCredentialFingerprint, loadCatalogCache, saveCatalogCache } from "../src/cache.js";

const PROVIDER_ID = "github-copilot";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
const STORE_MARKER_PREFIX = '"pi-dynamic-copilot-v2:';
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
type CopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface DynamicCopilotModelsOptions {
  /** Absolute, SDK-resolved agent directory. Defaults to pi's CLI directory resolution. */
  agentDir?: string;
  /** Active SDK credential when it is not stored in the agent directory. */
  credential?: unknown;
}

function startupCredential(options: DynamicCopilotModelsOptions, agentDir: string): unknown {
  if (options.credential !== undefined) return options.credential;
  const stored = readStoredCredential(PROVIDER_ID, join(agentDir, "auth.json"));
  if (stored !== undefined) return stored;
  const environmentToken = process.env.COPILOT_GITHUB_TOKEN;
  return environmentToken ? { type: "api_key", key: environmentToken } : undefined;
}

export function createDynamicCopilotModels(options: DynamicCopilotModelsOptions = {}): ExtensionFactory {
  return (pi) => registerDynamicCopilotModels(pi, options);
}

function registerDynamicCopilotModels(pi: ExtensionAPI, options: DynamicCopilotModelsOptions): void {
  const builtIn = githubCopilotProvider();
  const baseline = [...builtIn.getModels()] as Model<CopilotApi>[];
  const agentDir = options.agentDir ?? getAgentDir();
  const cachePath = getCatalogCachePath(agentDir);
  const startupFingerprint = getCredentialFingerprint(startupCredential(options, agentDir));
  const cached = loadCatalogCache(startupFingerprint, cachePath) as Model<CopilotApi>[] | undefined;
  // Pi resolves the default model, scoped models, and per-model thinking before
  // session_start. Seed the provider synchronously so dynamically discovered
  // IDs participate in that initial resolution.
  let models = cached ?? baseline;
  let catalogFingerprint = cached ? startupFingerprint : undefined;

  const provider: Provider<CopilotApi> = {
    ...builtIn,
    getModels: () => models,
    // A fetched picker/policy response is already account-filtered. Before
    // the first fetch, retain the built-in credential filter rather than
    // accidentally exposing every bundled model.
    filterModels: (available, credential) => {
      const fingerprint = getCredentialFingerprint(credential);
      return catalogFingerprint && fingerprint === catalogFingerprint
        ? available
        : (builtIn.filterModels?.(baseline, credential) ?? baseline);
    },
    refreshModels: async (context) => {
      const fingerprint = getCredentialFingerprint(context.credential);
      const storeMarker = fingerprint ? `${STORE_MARKER_PREFIX}${fingerprint}"` : undefined;
      const storedIsOurs = storeMarker !== undefined && context.stored?.etag === storeMarker;
      if (storedIsOurs && context.stored) {
        const restored = context.stored.models.filter((model) => model.provider === PROVIDER_ID) as Model<CopilotApi>[];
        if (restored.length > 0) {
          const published = await context.publish({
            update: () => {
              models = restored;
              catalogFingerprint = fingerprint;
            },
          });
          if (!published) return;
          await saveCatalogCache(restored, fingerprint, cachePath).catch(() => undefined);
        }
      }

      if (!context.allowNetwork || context.signal.aborted) return;
      if (
        !context.force &&
        storedIsOurs &&
        context.stored?.checkedAt !== undefined &&
        Date.now() - context.stored.checkedAt < REFRESH_INTERVAL_MS
      ) return;
      const payload = await fetchCopilotCatalog(context.credential, builtIn.baseUrl ?? DEFAULT_BASE_URL, context.signal);
      const discovered = parseCopilotCatalog(
        payload,
        baseline,
        getCopilotBaseUrl(context.credential, builtIn.baseUrl ?? DEFAULT_BASE_URL),
      ) as Model<CopilotApi>[];
      if (discovered.length === 0) throw new Error("GitHub Copilot returned no selectable tool-capable models");

      const published = await context.publish({
        ...(storeMarker ? { persist: { models: discovered, checkedAt: Date.now(), etag: storeMarker } } : {}),
        update: () => {
          models = discovered;
          catalogFingerprint = fingerprint;
        },
      });
      if (published) await saveCatalogCache(discovered, fingerprint, cachePath).catch(() => undefined);
    },
  };

  pi.registerProvider(provider);

  // Provider registration happens after pi's initial model-runtime refresh.
  // Refresh once when a real session starts so the first /model already has
  // the account's current catalog.
  pi.on("session_start", async (_event, ctx) => {
    const result = await ctx.modelRegistry.refresh({
      providers: [PROVIDER_ID],
      signal: AbortSignal.timeout(10_000),
    });
    const error = result.errors.get(PROVIDER_ID);
    if (error && ctx.hasUI) ctx.ui.notify(`Copilot model discovery failed: ${error.message}`, "warning");
  });

  pi.registerCommand("copilot-models-refresh", {
    description: "Refresh GitHub Copilot's account-specific model catalog",
    handler: async (_args, ctx) => {
      const before = new Set(ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).map((model) => model.id));
      const result = await ctx.modelRegistry.refresh({
        providers: [PROVIDER_ID],
        force: true,
        signal: AbortSignal.timeout(15_000),
      });
      const error = result.errors.get(PROVIDER_ID);
      if (error) {
        ctx.ui.notify(`Copilot model refresh failed: ${error.message}`, "error");
        return;
      }

      const current = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
      const added = current.map((model) => model.id).filter((id) => !before.has(id));
      const suffix = added.length > 0 ? ` Added: ${added.join(", ")}` : "";
      ctx.ui.notify(`GitHub Copilot catalog refreshed (${current.length} models).${suffix}`, "info");
    },
  });
}

export default createDynamicCopilotModels();
