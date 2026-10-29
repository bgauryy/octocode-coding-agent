/**
 * The six run states, named and shaped as in the terminal (`GLYPH` in `@octocodeai/octocode-tui`): ○ pending,
 * a spinner while running, ◇ waiting for the user, ✓ done, ✗ failed, ◼ stopped. `●` is presence ("Live"), never a state.
 */
export type UiState = "pending" | "running" | "waiting" | "done" | "failed" | "stopped";

/** A tool call's state; a call the model never finished (no result yet and no status) is pending. */
export function toolState(tool: { status: "running" | "completed" | "failed"; notRun?: true } | undefined): UiState {
	if (!tool) return "pending";
	if (tool.notRun) return "stopped";
	return tool.status === "running" ? "running" : tool.status === "failed" ? "failed" : "done";
}
