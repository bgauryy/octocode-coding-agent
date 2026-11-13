import type { TUI } from "@octocodeai/octocode-tui";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";

export const QA_CALL_PURPOSES = [
	{ mainGoal: "Find render stalls", reasoning: "Trace redraw work" },
	{ mainGoal: "Find save delays", reasoning: "Trace queued writes without blocking input" },
];
export const QA_RESULT_PURPOSES = [
	{ mainGoal: "Confirm render ownership", reasoning: "Read the scheduler entry" },
	{ mainGoal: "Confirm storage ownership", reasoning: "Read the asynchronous writer path" },
];

/** No renderer overrides: the production ToolExecutionComponent builds the same generic MCP display as a session. */
export function qaTool(ui: TUI, state: "tool-queries" | "tool-results"): ToolExecutionComponent {
	const args = { queries: QA_CALL_PURPOSES.map((purpose, index) => ({ ...purpose, path: "/synthetic/project", matchString: [index ? "save" : "render"] })) };
	const tool = new ToolExecutionComponent("mcp__octocode__localSearch", "synthetic-query-tool", args, { showImages: false, outputPad: 1 }, undefined, ui, "/synthetic/project");
	tool.setArgsComplete();
	tool.markExecutionStarted();
	tool.setExpanded(true);
	if (state === "tool-results") tool.updateResult({
		isError: false,
		content: [{ type: "text", text: "Two synthetic query results are available." }],
		structuredContent: { queries: QA_RESULT_PURPOSES },
		durationMs: 12,
	});
	return tool;
}
