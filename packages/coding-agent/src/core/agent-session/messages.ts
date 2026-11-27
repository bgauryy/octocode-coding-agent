/** Message helpers the session's agent event handling shares. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";

/** Find the last assistant message in agent state (including aborted ones) */
export function findLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg;
		}
	}
	return undefined;
}

export function replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
	// Agent-core stores the finalized message object in its state before emitting message_end.
	// SessionManager persistence happens later in _handleAgentEvent() with event.message.
	// Mutating this object in place keeps agent state, later turn/agent events, listeners,
	// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
	if (target === replacement) {
		return;
	}

	const targetRecord = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(targetRecord)) {
		delete targetRecord[key];
	}
	Object.assign(targetRecord, replacement);
}
