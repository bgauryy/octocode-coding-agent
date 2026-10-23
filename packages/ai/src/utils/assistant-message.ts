import type { Api, AssistantMessage, Model } from "../types.ts";

/** Zeroed usage for an assistant message that has not received any token counts yet. */
export function createEmptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Empty assistant message a provider stream fills in while it runs. `api` defaults to
 * the model's API; pass it when the adapter reports a fixed API name.
 */
export function createPendingAssistantMessage(model: Model<Api>, api: Api = model.api): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}
