import { type Component, Text } from "@octocodeai/octocode-tui";
import { theme } from "../../theme/theme.ts";
import { keyHint } from "../keybinding-hints.ts";

const FALLBACK_PREVIEW_LINES = 10;

/** Plain-text result preview for tools whose definition has no result renderer, or whose renderer threw. */
export function createResultFallback(output: string, expanded: boolean): Component | undefined {
	if (!output) {
		return undefined;
	}

	const lines = output.split("\n");
	const displayLines = expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
	const remaining = lines.length - displayLines.length;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return new Text(text, 0, 0);
}

/** Generic display for a tool with no renderer definition: title, JSON arguments and text output. */
export function formatToolExecution(toolName: string, args: any, output: string): string {
	let text = theme.fg("toolTitle", theme.bold(toolName));
	const content = JSON.stringify(args, null, 2);
	if (content) {
		text += `\n\n${content}`;
	}
	if (output) {
		text += `\n${output}`;
	}
	return text;
}
