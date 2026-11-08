import type { ApplicationTool } from "@octocodeai/octocode-contracts";

/**
 * The six run states, named and shaped as in the terminal (`GLYPH` in `@octocodeai/octocode-tui`): ○ pending,
 * a spinner while running, ◇ waiting for the user, ✓ done, ✗ failed, ◼ stopped. `●` is presence ("Live"), never a state.
 */
export type UiState = "pending" | "running" | "waiting" | "done" | "failed" | "stopped";

/** A tool call's state; a call the model never finished (no result yet and no status) is pending. */
export function toolState(tool: Pick<ApplicationTool, "status" | "notRun" | "display"> | undefined): UiState {
	if (!tool) return "pending";
	if (tool.notRun) return "stopped";
	if (tool.display?.state) return tool.display.state;
	if (tool.display?.outcome?.stopped && tool.status === "failed") return "stopped";
	return tool.status === "running" ? "running" : tool.status === "failed" ? "failed" : "done";
}
