import type { AgentMessage } from "@octocodeai/octocode-agent-core";

/**
 * The messages as a request declares them: tools the session hides stay out of the system messages' declarations. Every
 * request to the provider goes through this, and a request meant to reuse the session's cached prefix must too, because
 * a different tool array loses that prefix.
 */
export function withoutHiddenDeclarations(messages: AgentMessage[], hidden: ReadonlySet<string>): AgentMessage[] {
	if (hidden.size === 0) return messages;
	return messages.map((message) => {
		if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
		const { toolsAdded, toolsRemoved, ...rest } = message;
		const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
		const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
		return {
			...rest,
			...(added.length > 0 ? { toolsAdded: added } : {}),
			...(removed.length > 0 ? { toolsRemoved: removed } : {}),
		};
	});
}
