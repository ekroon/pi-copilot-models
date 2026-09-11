import type { Model, Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchCopilotCatalog, getCopilotBaseUrl, parseCopilotCatalog } from "../src/catalog.js";

const PROVIDER_ID = "github-copilot";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
const STORE_MARKER = '"pi-dynamic-copilot-v1"';
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
type CopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export default function dynamicCopilotModels(pi: ExtensionAPI): void {
  const builtIn = githubCopilotProvider();
  const baseline = [...builtIn.getModels()] as Model<CopilotApi>[];
  let models = baseline;
  let hasDynamicCatalog = false;

  const provider: Provider<CopilotApi> = {
    ...builtIn,
    getModels: () => models,
    // A fetched picker/policy response is already account-filtered. Before
    // the first fetch, retain the built-in credential filter rather than
    // accidentally exposing every bundled model.
    filterModels: (available, credential) =>
      hasDynamicCatalog ? available : (builtIn.filterModels?.(available, credential) ?? available),
    refreshModels: async (context) => {
      const storedIsOurs = context.stored?.etag === STORE_MARKER;
      if (storedIsOurs && context.stored) {
        const restored = context.stored.models.filter((model) => model.provider === PROVIDER_ID) as Model<CopilotApi>[];
        if (restored.length > 0) {
          const published = await context.publish({
            update: () => {
              models = restored;
              hasDynamicCatalog = true;
            },
          });
          if (!published) return;
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

      await context.publish({
        persist: { models: discovered, checkedAt: Date.now(), etag: STORE_MARKER },
        update: () => {
          models = discovered;
          hasDynamicCatalog = true;
        },
      });
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
