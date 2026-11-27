/**
 * Whether a failed model request may be sent again. A replay is silent, so it is safe only when the failed attempt
 * committed nothing the user or the world already saw: no text streamed to the screen and no tool executed. Otherwise the
 * error stands (or the documented recovery runs), rather than a second answer that repeats text or a tool's effect.
 */

import type { AgentEvent } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai";

/** What the latest model request committed before it failed. Reset when a request starts. */
export interface AttemptCommit {
	text: boolean;
	tool: boolean;
}

export const createAttemptCommit = (): AttemptCommit => ({ text: false, tool: false });

/**
 * Follows the agent's events: a new assistant message starts a clean attempt; text deltas and tool starts mark it. With
 * `earlyStart` a finished call block may already be running (its start event only comes with the finished message), so
 * it counts as a tool run.
 */
export function observeAttempt(attempt: AttemptCommit, event: AgentEvent, earlyStart: boolean): void {
	if (event.type === "message_start" && event.message.role === "assistant") {
		attempt.text = false;
		attempt.tool = false;
	} else if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta" && update.delta.trim() !== "") attempt.text = true;
		else if (update.type === "toolcall_end" && earlyStart) attempt.tool = true;
	} else if (event.type === "tool_execution_start") {
		attempt.tool = true;
	}
}

/** What the failed attempt left behind, or undefined when replaying it is safe. */
export function committedBy(attempt: AttemptCommit, message: AssistantMessage): "text" | "tool" | undefined {
	if (attempt.tool) return "tool";
	if (attempt.text) return "text";
	const shown = message.content.some((block) => block.type === "text" && block.text.trim() !== "");
	return shown ? "text" : undefined;
}
