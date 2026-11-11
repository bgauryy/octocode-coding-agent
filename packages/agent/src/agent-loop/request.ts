import type { AgentContext, AgentLoopConfig, AgentMessage, AgentRequestUpdate } from "../types.ts";
import type { AgentEventSink } from "./events.ts";
import { inputCommitter } from "./input.ts";

/** The config with the model and thinking level an update replaces; `"off"` clears reasoning. */
export function withModelUpdate(config: AgentLoopConfig, update: AgentRequestUpdate): AgentLoopConfig {
	return {
		...config,
		model: update.model ?? config.model,
		reasoning:
			update.thinkingLevel === undefined
				? config.reasoning
				: update.thinkingLevel === "off"
					? undefined
					: update.thinkingLevel,
	};
}

export async function prepareProviderRequest(
	initialContext: AgentContext,
	initialConfig: AgentLoopConfig,
	recorded: AgentMessage[],
	emit: AgentEventSink,
	inputSelected: boolean,
	signal?: AbortSignal,
) {
	let context = initialContext;
	let config = initialConfig;
	let update: AgentRequestUpdate | void = undefined;
	// A long preparation may request one final input selection. Never take a second batch
	// in one-at-a-time mode, or recursively refresh input while rebuilding the request.
	for (let attempt = 0; attempt < 2; attempt++) {
		update = await config.prepareRequest?.(
			{ context, model: config.model, thinkingLevel: config.reasoning ?? "off" },
			signal,
		);
		if (update) {
			context = update.context ?? context;
			config = withModelUpdate(config, update);
		}
		if (attempt > 0 || !update?.refreshInput || inputSelected || signal?.aborted) break;
		const messages = (await config.getSteeringMessages?.()) ?? [];
		if (!messages.length) break;
		const batch = { kind: "steer" as const, messages };
		config.onInputSelected?.(batch);
		const commit = inputCommitter(context, recorded, emit);
		const input = await config.prepareInput?.(batch, signal, commit);
		await commit(input?.messages ?? messages, input?.stop ? signal : undefined);
		if (input?.stop) return { context, config, update, stop: true };
	}
	return { context, config, update, stop: false };
}
