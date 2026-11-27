import type { ApplicationThinkingLevel } from "@octocodeai/octocode-contracts";
import type { ApplicationSession } from "../session-port.ts";

/**
 * What the model commands call: the session methods RPC `set_model` and `set_thinking_level` call. Optional so a session
 * without them (a fixture) still runs the other commands; a model command then fails.
 */
export type ModelCommandSession = Partial<
	Pick<ApplicationSession, "model" | "modelRuntime" | "setModel" | "setThinkingLevel" | "getAvailableThinkingLevels">
>;

/** Switch to an available model, as RPC `set_model` does; a model the session does not list fails the command. */
export async function selectModel(session: ModelCommandSession, provider: string, modelId: string): Promise<void> {
	const runtime = session.modelRuntime;
	if (!runtime || !session.setModel) throw new Error("This session cannot switch models");
	const model = runtime.getAvailableSnapshot().find((item) => item.provider === provider && item.id === modelId);
	if (!model) throw new Error(`Model not found: ${provider}/${modelId}. Choose one the session lists.`);
	await session.setModel(model);
}

/**
 * Ask for a thinking level, as RPC `set_thinking_level` does: the session clamps it to the levels the current model
 * accepts. A model without thinking control fails the command instead of ignoring it.
 */
export function selectThinking(session: ModelCommandSession, level: ApplicationThinkingLevel): void {
	const model = session.model;
	if (!session.setThinkingLevel) throw new Error("This session cannot change its thinking level");
	if (model && session.getAvailableThinkingLevels?.().length === 0)
		throw new Error(`${model.provider}/${model.id} has no thinking levels`);
	session.setThinkingLevel(level);
}
