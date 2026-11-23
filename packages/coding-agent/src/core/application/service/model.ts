import {
	APPLICATION_THINKING_LEVELS,
	type ApplicationBilling,
	type ApplicationEvent,
	type ApplicationModelOption,
	type ApplicationProviderKind,
	type ApplicationSnapshot,
	type ApplicationThinkingLevel,
} from "@octocodeai/octocode-contracts";
import { activeRates } from "@octocodeai/octocode-ai";
import type { ApplicationSession } from "../session-port.ts";
import type { ApplicationStateStore } from "../state.ts";

type ModelSource = Pick<ApplicationSession, "model" | "modelRuntime" | "thinkingLevel" | "getAvailableThinkingLevels">;

const LEVELS: ReadonlySet<string> = new Set(APPLICATION_THINKING_LEVELS);
const isLevel = (level: unknown): level is ApplicationThinkingLevel => typeof level === "string" && LEVELS.has(level);
/** The most models a picker gets (`ApplicationModelOptionSchema` list bound). */
const MAX_MODELS = 2000;

/** The selected model, with its thinking level, the levels it accepts, who pays for it and its provider's kind. */
export function applicationModel(session: ModelSource): ApplicationSnapshot["model"] {
	const model = session.model;
	if (!model) return undefined;
	const billing = session.modelRuntime?.getProviderBilling(model.provider);
	const kind = session.modelRuntime?.getProviderKind(model.provider);
	const level = session.thinkingLevel;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		input: [...model.input],
		...(isLevel(level) ? { thinkingLevel: level } : {}),
		...(session.getAvailableThinkingLevels
			? { thinkingLevels: session.getAvailableThinkingLevels().filter(isLevel) }
			: {}),
		...(billing ? { billing } : {}),
		...(kind ? { kind } : {}),
	};
}

const price = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The models `setModel` accepts (the runtime's available models), with list prices, billing and provider kind, for the
 * web picker. Undefined for a session without a model runtime. One pass over the available models; billing and kind
 * are asked once a provider.
 */
export function applicationModels(
	session: Pick<ApplicationSession, "modelRuntime">,
): ApplicationModelOption[] | undefined {
	const runtime = session.modelRuntime;
	if (!runtime) return undefined;
	const providers = new Map<string, { billing: ApplicationBilling; kind: ApplicationProviderKind }>();
	const options: ApplicationModelOption[] = [];
	for (const model of runtime.getAvailableSnapshot()) {
		if (options.length >= MAX_MODELS) break;
		// Outside the contract's bounds a whole frame would be refused; such an id cannot be typed back anyway.
		if (!model.provider || model.provider.length > 128 || !model.id || model.id.length > 256) continue;
		let provider = providers.get(model.provider);
		if (!provider)
			providers.set(
				model.provider,
				(provider = {
					billing: runtime.getProviderBilling(model.provider),
					kind: runtime.getProviderKind(model.provider),
				}),
			);
		const rates = model.cost ? activeRates(model.cost) : undefined;
		const window = Math.floor(price(model.contextWindow));
		options.push({
			provider: model.provider,
			id: model.id,
			name: (model.name || model.id).slice(0, 256),
			billing: provider.billing,
			kind: provider.kind,
			...(rates ? { cost: { input: price(rates.input), output: price(rates.output) } } : {}),
			...(model.reasoning ? { reasoning: true } : {}),
			...(window > 0 ? { contextWindow: window } : {}),
		});
	}
	return options;
}

export function publishModelChange(
	session: ModelSource,
	state: ApplicationStateStore,
	publish: (event: ApplicationEvent) => void,
): void {
	const model = applicationModel(session);
	if (JSON.stringify(model) !== JSON.stringify(state.getState().model)) publish({ type: "session.model", model });
}
