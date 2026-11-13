import type { LlamaModelInfo } from "./client.ts";

/** Runtime and configured limits take precedence over a model's training capacity. */
export function contextWindowOf(model: LlamaModelInfo, cachedContextWindow?: number): number | undefined {
	const runtimeContextWindow = model.meta?.n_ctx;
	if (runtimeContextWindow && runtimeContextWindow > 0) return runtimeContextWindow;
	const args = model.status.args ?? [];
	for (let index = 0; index < args.length - 1; index++) {
		const flag = args[index];
		if (flag !== "--ctx-size" && flag !== "-c" && flag !== "-ctx") continue;
		const contextWindow = Number(args[index + 1]);
		if (Number.isSafeInteger(contextWindow) && contextWindow > 0) return contextWindow;
	}
	if (cachedContextWindow && cachedContextWindow > 0) return cachedContextWindow;
	const trainingContextWindow = model.meta?.n_ctx_train;
	return trainingContextWindow && trainingContextWindow > 0 ? trainingContextWindow : undefined;
}
