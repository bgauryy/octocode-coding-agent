import type { ModelRoute, ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";
import { decide } from "./decide.ts";
import { collectFacts, type SmartRouterHost } from "./host.ts";
import { readState } from "./state.ts";
import type { SmartRouterOptions, SmartRouterState } from "./types.ts";

export { type DecisionInput, decide, SmartRouterError } from "./decide.ts";
export type { SmartRouterHost } from "./host.ts";
export * from "./types.ts";

const SMART_ROUTER_PROVIDER = "octocode";
const SMART_ROUTER_ID = "auto-code";

const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Smart routing was cancelled");
}

/** The virtual model definition. Pure policy runs in `decide`; this binds it to the runtime's facts. */
function createSmartRouterDefinition(
	host: SmartRouterHost,
	options: SmartRouterOptions = {},
): VirtualModelDefinition<SmartRouterState> {
	return {
		provider: options.provider ?? SMART_ROUTER_PROVIDER,
		id: options.id ?? SMART_ROUTER_ID,
		name: options.name ?? "Auto Code",
		thinkingLevels: options.thinkingLevels ?? DEFAULT_LEVELS,
		input: ["text", "image"],
		route(request: ModelRouteRequest<SmartRouterState>): ModelRoute<SmartRouterState> {
			if (request.signal?.aborted) throw abortError(request.signal);
			const decision = decide({
				reason: request.reason,
				thinkingLevel: request.thinkingLevel,
				messages: request.messages,
				previous: request.previous,
				failed: request.failed,
				state: readState(request.state),
				facts: collectFacts(host),
				options,
			});
			options.onDecision?.(decision.explanation);
			return {
				model: decision.model,
				thinkingLevel: decision.thinkingLevel,
				state: decision.state,
			};
		},
	};
}

/**
 * Register the auto-code virtual model. Call during session setup, after the providers it may route to.
 * Returns a function that removes it.
 */
export function registerSmartRouter(
	runtime: SmartRouterHost & {
		registerVirtualModel(definition: VirtualModelDefinition<SmartRouterState>): void;
		unregisterVirtualModel(providerId: string, id: string): void;
	},
	options: SmartRouterOptions = {},
): () => void {
	const definition = createSmartRouterDefinition(runtime, options);
	runtime.registerVirtualModel(definition);
	return () => runtime.unregisterVirtualModel(definition.provider, definition.id);
}
