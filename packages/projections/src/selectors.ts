import type { ApplicationMessage, ApplicationTool, UiState } from "@octocodeai/octocode-contracts";

/**
 * Whether an interface shows the message: never one the host marked `display: false`, and a custom message (host
 * context such as restored files or routing notices) only when the host marked it displayed. Session entries may also
 * hold `"only"` (shown, never sent to the model).
 */
export function applicationMessageDisplayed(message: {
	readonly role: ApplicationMessage["role"];
	readonly display?: boolean | "only";
}): boolean {
	if (message.display === false) return false;
	return message.role !== "custom" || message.display === true || message.display === "only";
}

/** What a tool call's state reads from. A terminal row fills it from its own phase; the stream's tools already have it. */
export type ToolStateInput = Pick<ApplicationTool, "status" | "notRun" | "display">;

/** The state the host's display forces over the call's status, if any: its own `state`, or a stopped outcome. */
export function toolDisplayState(tool: Pick<ToolStateInput, "status" | "display">): UiState | undefined {
	if (tool.display?.state) return tool.display.state;
	if (tool.display?.outcome?.stopped && tool.status === "failed") return "stopped";
	return undefined;
}

/** A tool call's state; a call the model never finished (no result yet and no status) is pending. */
export function toolState(tool: ToolStateInput | undefined): UiState {
	if (!tool) return "pending";
	if (tool.notRun) return "stopped";
	return (
		toolDisplayState(tool) ?? (tool.status === "running" ? "running" : tool.status === "failed" ? "failed" : "done")
	);
}
