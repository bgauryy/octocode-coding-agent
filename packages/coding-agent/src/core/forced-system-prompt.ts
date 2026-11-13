import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage, type SystemMessage } from "@octocodeai/octocode-ai";

export interface RequestSystemOverride {
	sessionId: string;
	leafId: string | null;
	forced?: string;
}

/** The transient override live and cache-sharing requests use; the recorded instruction state stays unchanged. */
export function projectForcedSystemPrompt(messages: AgentMessage[], forced: string | undefined): AgentMessage[] {
	if (forced === undefined) return messages;
	const current = getCurrentSystemMessage(messages);
	const head: SystemMessage = {
		role: "system",
		content: forced,
		...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
		timestamp: current?.timestamp ?? Date.now(),
	};
	return [head, ...messages.filter((message) => message.role !== "system")];
}
