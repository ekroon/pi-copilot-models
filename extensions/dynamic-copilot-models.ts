import type { Model, Provider } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  ModelRuntime,
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  buildCopilotCatalog,
  fetchCopilotCatalog,
  getCopilotBaseUrl,
  type CopilotCatalog,
  type CopilotModelRoute,
  type CopilotModelRoutes,
} from "../src/catalog.js";
import { getCatalogCachePath, getCredentialFingerprint, loadCatalogCache, saveCatalogCache } from "../src/cache.js";
import {
  CopilotRouteRegistry,
  normalizeCopilotAssistantMessage,
  transformCopilotRequest,
} from "../src/request-routing.js";
import { withCopilotUsage } from "../src/copilot-usage.js";

const PROVIDER_ID = "github-copilot";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
const STORE_MARKER_PREFIX = "pi-dynamic-copilot-v6:";
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
type CopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface DynamicCopilotModelsOptions {
  /** Absolute, SDK-resolved agent directory. Defaults to pi's CLI directory resolution. */
  agentDir?: string;
  /** Active SDK credential when it is not stored in the agent directory. */
  credential?: unknown;
}

export type CopilotSelectionReconciliation =
  | { status: "not-selected" | "selection-changed" | "current" }
  | { status: "replaced" | "fallback"; model: Model<CopilotApi> }
  | { status: "unavailable" };

/**
 * Refresh replaces provider model objects. Re-select the equivalent published
 * object so pi does not retain old limits, cost, compatibility, or routing.
 */
export async function reconcileCopilotSelection(
  pi: Pick<ExtensionAPI, "setModel">,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  selectedBeforeRefresh: Model<CopilotApi> | undefined,
  previousRoute?: { canonicalModelId: string },
): Promise<CopilotSelectionReconciliation> {
  if (!selectedBeforeRefresh || selectedBeforeRefresh.provider !== PROVIDER_ID) return { status: "not-selected" };

  const current = ctx.model;
  if (
    current &&
    (current.provider !== selectedBeforeRefresh.provider || current.id !== selectedBeforeRefresh.id)
  ) return { status: "selection-changed" };

  const exact = ctx.modelRegistry.find(PROVIDER_ID, selectedBeforeRefresh.id) as Model<CopilotApi> | undefined;
  if (exact === current) return { status: "current" };

  const canonicalFallback = previousRoute && previousRoute.canonicalModelId !== selectedBeforeRefresh.id
    ? ctx.modelRegistry.find(PROVIDER_ID, previousRoute.canonicalModelId) as Model<CopilotApi> | undefined
    : undefined;
  const providerFallback = ctx.modelRegistry.getAvailable().find((model) => model.provider === PROVIDER_ID) as
    | Model<CopilotApi>
    | undefined;
  const catalogFallback = ctx.modelRegistry.getAll().find((model) => model.provider === PROVIDER_ID) as
    | Model<CopilotApi>
    | undefined;
  const target = exact ?? canonicalFallback ?? providerFallback ?? catalogFallback;
  if (!target || !(await pi.setModel(target))) return { status: "unavailable" };
  return { status: exact ? "replaced" : "fallback", model: target };
}

export function createCacheSaveWarningReporter(
  report: (message: string) => void = (message) => console.warn(message),
): (error: unknown) => void {
  const reported = new Set<string>();
  return (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Copilot catalog cache save failed (continuing without disk cache): ${detail}`;
    if (reported.has(message)) return;
    reported.add(message);
    report(message);
  };
}

function canonicalCatalog(models: readonly Model<CopilotApi>[]): CopilotCatalog {
  const routes = new Map<string, { canonicalModelId: string; contextTier: "default" }>();
  for (const model of models) {
    routes.set(model.id, { canonicalModelId: model.id, contextTier: "default" });
  }
  return { models: [...models], routes };
}

function routesForModels(
  models: readonly Model<CopilotApi>[],
  availableRoutes: CopilotModelRoutes,
): CopilotModelRoutes | undefined {
  const routes = new Map<string, CopilotModelRoute>();
  for (const model of models) {
    const route = availableRoutes.get(model.id);
    if (!route) return undefined;
    routes.set(model.id, route);
  }
  return routes;
}

function catalogStoreMarker(fingerprint: string, catalog: Readonly<CopilotCatalog>): string {
  const snapshot = catalog.models.map((model) => ({ model, route: catalog.routes.get(model.id) }));
  const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return `${STORE_MARKER_PREFIX}${fingerprint}:${digest}`;
}

function startupCredential(options: DynamicCopilotModelsOptions, agentDir: string): unknown {
  if (options.credential !== undefined) return options.credential;
  const stored = readStoredCredential(PROVIDER_ID, join(agentDir, "auth.json"));
  if (stored !== undefined) return stored;
  const environmentToken = process.env.COPILOT_GITHUB_TOKEN;
  return environmentToken ? { type: "api_key", key: environmentToken } : undefined;
}

async function loadBuiltInCopilotProvider(): Promise<Provider<CopilotApi>> {
  // Installed git packages do not have their peer dependencies in a local
  // node_modules directory. Pi aliases the public package roots for them, but
  // jiti cannot resolve pi-ai's provider subpath through that alias. Obtain the
  // same built-in provider through coding-agent's public runtime API instead.
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const provider = runtime.getProvider(PROVIDER_ID) as Provider<CopilotApi> | undefined;
  if (!provider) throw new Error("Pi's built-in GitHub Copilot provider is unavailable");
  return provider;
}

export function createDynamicCopilotModels(options: DynamicCopilotModelsOptions = {}): ExtensionFactory {
  return async (pi) => registerDynamicCopilotModels(pi, options, await loadBuiltInCopilotProvider());
}

function registerDynamicCopilotModels(
  pi: ExtensionAPI,
  options: DynamicCopilotModelsOptions,
  builtIn: Provider<CopilotApi>,
): void {
  const baseline = [...builtIn.getModels()] as Model<CopilotApi>[];
  const meteredBuiltIn = withCopilotUsage(builtIn);
  const agentDir = options.agentDir ?? getAgentDir();
  const cachePath = getCatalogCachePath(agentDir);
  const initialCredential = startupCredential(options, agentDir);
  const startupFingerprint = getCredentialFingerprint(initialCredential);
  const startupBaseUrl = getCopilotBaseUrl(initialCredential, builtIn.baseUrl ?? DEFAULT_BASE_URL);
  const cached = loadCatalogCache(startupFingerprint, cachePath, {
    inferenceBaseUrl: startupBaseUrl,
  }) as CopilotCatalog | undefined;
  // Pi resolves the default model, scoped models, and per-model thinking before
  // session_start. Seed models and their explicit routes synchronously so
  // dynamically discovered IDs participate in that initial resolution.
  const startupCatalog = cached ?? canonicalCatalog(baseline);
  let models = startupCatalog.models as Model<CopilotApi>[];
  let catalogRoutes = startupCatalog.routes;
  const routeRegistry = new CopilotRouteRegistry();
  routeRegistry.register(startupCatalog.models, startupCatalog.routes);
  let catalogFingerprint = cached ? startupFingerprint : undefined;
  const warnCacheSaveFailure = createCacheSaveWarningReporter();

  const notifyReconciliation = (
    ctx: Pick<ExtensionContext, "hasUI" | "ui">,
    selected: Model<CopilotApi> | undefined,
    result: CopilotSelectionReconciliation,
  ): void => {
    if (!selected || (result.status !== "fallback" && result.status !== "unavailable")) return;
    const from = `${selected.provider}/${selected.id}`;
    const message = result.status === "fallback"
      ? `${from} is no longer available; switched to ${result.model.provider}/${result.model.id}.`
      : `${from} could not be rebound to the refreshed catalog and no safe replacement could be selected. Choose a model before sending a request.`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
  };

  const provider: Provider<CopilotApi> = {
    ...meteredBuiltIn,
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
      const startupMarker = fingerprint
        ? catalogStoreMarker(fingerprint, { models, routes: catalogRoutes })
        : undefined;
      const storedIsOurs = startupMarker !== undefined && context.stored?.etag === startupMarker;
      let restoredFromStore = false;
      if (storedIsOurs && context.stored) {
        const restored = context.stored.models.filter((model) => model.provider === PROVIDER_ID) as Model<CopilotApi>[];
        const restoredRoutes = routesForModels(restored, catalogRoutes);
        // pi's provider store predates route metadata. Restore it only when the
        // credential-bound startup cache can route every stored model safely.
        if (restored.length > 0 && restoredRoutes) {
          const restoredCatalog: CopilotCatalog = { models: restored, routes: restoredRoutes };
          const published = await context.publish({
            update: () => {
              routeRegistry.register(restored, restoredRoutes);
              models = restored;
              catalogRoutes = restoredRoutes;
              catalogFingerprint = fingerprint;
            },
          });
          if (!published) return;
          restoredFromStore = true;
          await saveCatalogCache(restoredCatalog, fingerprint, cachePath).catch(warnCacheSaveFailure);
        }
      }

      if (!context.allowNetwork || context.signal.aborted) return;
      if (
        !context.force &&
        restoredFromStore &&
        context.stored?.checkedAt !== undefined &&
        Date.now() - context.stored.checkedAt < REFRESH_INTERVAL_MS
      ) return;
      const payload = await fetchCopilotCatalog(context.credential, builtIn.baseUrl ?? DEFAULT_BASE_URL, context.signal);
      const discovered = buildCopilotCatalog(
        payload,
        baseline,
        getCopilotBaseUrl(context.credential, builtIn.baseUrl ?? DEFAULT_BASE_URL),
      );
      if (discovered.models.length === 0) throw new Error("GitHub Copilot returned no selectable tool-capable models");

      const storeMarker = fingerprint ? catalogStoreMarker(fingerprint, discovered) : undefined;
      const published = await context.publish({
        ...(storeMarker ? { persist: { models: discovered.models, checkedAt: Date.now(), etag: storeMarker } } : {}),
        update: () => {
          routeRegistry.register(discovered.models, discovered.routes);
          models = discovered.models as Model<CopilotApi>[];
          catalogRoutes = discovered.routes;
          catalogFingerprint = fingerprint;
        },
      });
      if (published) await saveCatalogCache(discovered, fingerprint, cachePath).catch(warnCacheSaveFailure);
    },
  };

  pi.registerProvider(provider);

  pi.on("before_provider_request", (event, ctx) => {
    const selected = ctx.model;
    if (!selected) return;
    return transformCopilotRequest(selected.provider, selected.id, event.payload, routeRegistry.get(selected));
  });

  pi.on("message_end", (event, ctx) => {
    const selected = ctx.model;
    if (!selected || event.message.role !== "assistant") return;
    const message = normalizeCopilotAssistantMessage(event.message, selected, routeRegistry.get(selected));
    if (message !== event.message) return { message };
  });

  // Provider registration happens after pi's initial model-runtime refresh.
  // Refresh once when a real session starts so the first /model already has
  // the account's current catalog.
  pi.on("session_start", async (_event, ctx) => {
    const selected = ctx.model as Model<CopilotApi> | undefined;
    const previousRoute = selected ? routeRegistry.get(selected) : undefined;
    const result = await ctx.modelRegistry.refresh({
      providers: [PROVIDER_ID],
      signal: AbortSignal.timeout(10_000),
    });
    const reconciliation = await reconcileCopilotSelection(pi, ctx, selected, previousRoute);
    notifyReconciliation(ctx, selected, reconciliation);
    const error = result.errors.get(PROVIDER_ID);
    if (error && ctx.hasUI) ctx.ui.notify(`Copilot model discovery failed: ${error.message}`, "warning");
  });

  pi.registerCommand("copilot-models-refresh", {
    description: "Refresh GitHub Copilot's account-specific model catalog",
    handler: async (_args, ctx) => {
      const selected = ctx.model as Model<CopilotApi> | undefined;
      const previousRoute = selected ? routeRegistry.get(selected) : undefined;
      const before = new Set(ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).map((model) => model.id));
      const result = await ctx.modelRegistry.refresh({
        providers: [PROVIDER_ID],
        force: true,
        signal: AbortSignal.timeout(15_000),
      });
      const reconciliation = await reconcileCopilotSelection(pi, ctx, selected, previousRoute);
      notifyReconciliation(ctx, selected, reconciliation);
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
