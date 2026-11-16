import type { ApplicationTool, UiState } from "@octocodeai/octocode-contracts";

/** The six run states, shared with the terminal; `●` is presence ("Live"), never a state. */
export type { UiState } from "@octocodeai/octocode-contracts";

/** A tool call's state; a call the model never finished (no result yet and no status) is pending. */
export function toolState(tool: Pick<ApplicationTool, "status" | "notRun" | "display"> | undefined): UiState {
	if (!tool) return "pending";
	if (tool.notRun) return "stopped";
	if (tool.display?.state) return tool.display.state;
	if (tool.display?.outcome?.stopped && tool.status === "failed") return "stopped";
	return tool.status === "running" ? "running" : tool.status === "failed" ? "failed" : "done";
}
