import type { Api, AssistantMessage, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { CopilotModelRoute, CopilotModelRoutes } from "./catalog.js";

export const COPILOT_PROVIDER_ID = "github-copilot";

const ROUTE_OWNER = Symbol("pi-dynamic-copilot-route-owner");
type RoutableModel = Pick<Model<Api>, "id" | "provider" | "api">;
interface OwnedRoute {
  route: CopilotModelRoute;
}
type RouteOwnedModel = RoutableModel & { [ROUTE_OWNER]?: OwnedRoute };

/**
 * Bind routing to model objects, rather than only to IDs.
 *
 * A generated alias can later become a real canonical GitHub model ID, so an
 * ID-keyed map could silently transfer the old route. Routes are immutable and
 * owned by each published model object: publishing a replacement gives the new
 * object its new route without invalidating an independently retained active
 * object (for example, when pi refreshes while /model is opened and cancelled).
 * The enumerable symbol survives pi's supported model-override object spreads;
 * JSON caches intentionally omit it and are rebound after loading.
 */
export class CopilotRouteRegistry {
  private readonly byModel = new WeakMap<object, OwnedRoute>();

  register(models: readonly Model<Api>[], routes: CopilotModelRoutes): void {
    for (const model of models) {
      const route = routes.get(model.id);
      if (!route) continue;
      const ownedRoute = Object.freeze({ route: Object.freeze({ ...route }) });
      Object.defineProperty(model, ROUTE_OWNER, {
        value: ownedRoute,
        enumerable: true,
        configurable: true,
      });
      this.byModel.set(model, ownedRoute);
    }
  }

  get(model: RoutableModel): CopilotModelRoute | undefined {
    const owned = this.byModel.get(model) ?? (model as RouteOwnedModel)[ROUTE_OWNER];
    return owned?.route;
  }
}

/**
 * Copilot context tiers have no dedicated inference wire field.
 *
 * The checked-in local Copilot CLI schema says that tier selection derives
 * effective model capability overrides (prompt/context limits). No sanitized
 * raw paired request captures were available to substantiate a transport-wide
 * wire encoding. Publishing remains gated on advertised valid tier limits, and
 * this helper conservatively adds no guessed `context_tier` property or
 * `x-*context*` header.
 */
export function transformCopilotRequest(
  providerId: string,
  selectedModelId: string,
  payload: unknown,
  route: CopilotModelRoute | undefined,
): unknown {
  if (providerId !== COPILOT_PROVIDER_ID || !route || route.canonicalModelId === selectedModelId) return payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const request = payload as Record<string, unknown>;
  if (typeof request.model !== "string") return payload;

  // Another transform may already have canonicalized this request. A payload
  // for any other model is a mismatch and must not be rewritten merely because
  // the selected ID happens to have a known route.
  if (request.model === route.canonicalModelId) return payload;
  if (request.model !== selectedModelId) return payload;
  return { ...request, model: route.canonicalModelId };
}

/**
 * The Anthropic adapter replaces AssistantMessage.model with the canonical
 * model reported by Copilot. Restore pi's selected synthetic ID at the
 * supported message_end boundary and retain the wire model diagnostically.
 * This makes session persistence resolve the same variant and lets Anthropic's
 * same-model replay preserve signed/redacted thinking blocks.
 */
export function normalizeCopilotAssistantMessage(
  message: AssistantMessage,
  selectedModel: RoutableModel,
  route: CopilotModelRoute | undefined,
): AssistantMessage {
  if (
    selectedModel.provider !== COPILOT_PROVIDER_ID ||
    selectedModel.api !== "anthropic-messages" ||
    message.provider !== COPILOT_PROVIDER_ID ||
    message.api !== "anthropic-messages" ||
    !route ||
    route.canonicalModelId === selectedModel.id ||
    message.model !== route.canonicalModelId
  ) return message;

  return {
    ...message,
    model: selectedModel.id,
    responseModel: message.responseModel ?? route.canonicalModelId,
  };
}

/** Conservatively leave headers unchanged rather than inventing a tier header. */
export function transformCopilotHeaders(headers: ProviderHeaders): ProviderHeaders {
  return headers;
}
