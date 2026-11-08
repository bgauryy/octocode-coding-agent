import type { ToolDisplay } from "@octocodeai/octocode-contracts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { buildToolDisplay } from "../../core/application/transcript-display.ts";
import type { ToolRenderers } from "../../core/features/types.ts";

type ToolEvent = Extract<
	AgentSessionEvent,
	{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

/** The text blocks of a result, joined. */
function resultText(result: unknown): string {
	const content = result && typeof result === "object" && "content" in result ? result.content : undefined;
	return Array.isArray(content)
		? content
				.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
				.join("\n")
		: "";
}

/**
 * Adds each tool event's `display` (how every surface draws the call) to the RPC stream, so a client such as the ACP
 * broker draws calls like the terminal and web do. The end event has no arguments, so those of the call's start are kept.
 */
export function createToolDisplayAttacher(renderers: (toolName: string) => ToolRenderers | undefined) {
	const args = new Map<string, unknown>();
	return <E extends AgentSessionEvent>(event: E): E | (ToolEvent & { display: ToolDisplay }) => {
		if (
			event.type !== "tool_execution_start" &&
			event.type !== "tool_execution_update" &&
			event.type !== "tool_execution_end"
		)
			return event;
		const tool: ToolEvent = event;
		if (tool.type !== "tool_execution_end") args.set(tool.toolCallId, tool.args);
		const result =
			tool.type === "tool_execution_end"
				? tool.result
				: tool.type === "tool_execution_update"
					? tool.partialResult
					: undefined;
		const status = tool.type === "tool_execution_end" ? (tool.isError ? "failed" : "completed") : "running";
		const callArgs = args.get(tool.toolCallId);
		if (tool.type === "tool_execution_end") args.delete(tool.toolCallId);
		try {
			const display = buildToolDisplay(renderers(tool.toolName)?.display, {
				toolName: tool.toolName,
				args: callArgs,
				result,
				text: resultText(result),
				status,
			});
			return { ...tool, display };
		} catch {
			// A display that cannot be built leaves the event as it was: the stream never stops for it.
			return event;
		}
	};
}
