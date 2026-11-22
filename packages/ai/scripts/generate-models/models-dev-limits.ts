import type { Limit } from "@opencode-ai/models";

/** Token ceilings for a provider listing. Sparse catalogs may report zero or omit either limit. */
export function modelsDevLimits(
	limit: Partial<Limit> | undefined,
	fallback = { contextWindow: 4096, maxTokens: 4096 },
) {
	const tokens = (value: number | undefined, missing: number) =>
		value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : missing;
	const contextWindow = tokens(limit?.context, fallback.contextWindow);
	const input = tokens(limit?.input, 0);
	return {
		contextWindow,
		...(input > 0 && input < contextWindow ? { inputLimits: { maxInputTokens: input } } : {}),
		maxTokens: tokens(limit?.output, fallback.maxTokens),
	};
}
