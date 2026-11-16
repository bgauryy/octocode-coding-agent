import { type Component, Container, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../../common/src/sanitize.ts";
import { theme } from "../../../../theme/theme.ts";
import { colorToolOutput } from "../../../../theme/output-style.ts";
import { foldHint, TOOL_PREVIEW_LINES } from "../../../../theme/theme-tui-helpers.ts";

/** One line naming a renderer failure. Extension renderers are untrusted: the text is sanitized and kept to its first line. */
function rendererError(error: unknown): string {
	let text: string;
	try {
		text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} catch {
		text = "unknown error";
	}
	return (sanitizeTerminalText(text).split("\n")[0] ?? "").trim().slice(0, 200) || "unknown error";
}

/**
 * The plain fallback of a renderer slot that threw, followed by a warning that names the error, so a broken renderer
 * degrades visibly instead of silently.
 */
export function rendererFailure(
	slot: "renderCall" | "renderResult",
	error: unknown,
	fallback: Component | undefined,
): Component {
	const container = new Container();
	if (fallback) container.addChild(fallback);
	container.addChild(
		new Text(
			theme.fg("warning", `${slot === "renderCall" ? "Call" : "Result"} renderer failed: ${rendererError(error)}`),
			0,
			0,
		),
	);
	return container;
}

/** Plain-text result preview for tools whose definition has no result renderer, or whose renderer threw. */
export function createResultFallback(output: string, expanded: boolean): Component | undefined {
	if (!output) {
		return undefined;
	}

	const clean = sanitizeTerminalText(output);
	const lines = clean.split("\n");
	const displayLines = expanded ? lines : lines.slice(0, TOOL_PREVIEW_LINES);
	const remaining = lines.length - displayLines.length;
	// Diffs, JSON and key lines come coloured, the folded rest plain (`colorToolOutput`); anything else is flat.
	let text =
		colorToolOutput(theme, clean, { expanded, previewLines: TOOL_PREVIEW_LINES })
			?.split("\n")
			.slice(0, displayLines.length)
			.join("\n") ?? displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `\n${foldHint(remaining)}`;
	}
	return new Text(text, 0, 0);
}

/** A row whose components threw while drawing: a notice naming the error above the generic display. */
export function rendererFailureText(
	error: unknown,
	toolName: string,
	args: unknown,
	output: string,
	expanded: boolean,
): string {
	return `${theme.fg("warning", `${toolName} renderer failed: ${rendererError(error)}`)}\n${formatToolExecution(toolName, args, output, expanded)}`;
}

/** Generic display for a tool with no renderer definition: title, JSON arguments and text output. */
function formatToolExecution(toolName: string, args: unknown, output: string, expanded = false): string {
	let text = theme.fg("toolTitle", theme.bold(sanitizeTerminalText(toolName)));
	const content = JSON.stringify(args, null, 2);
	if (content) {
		text += `\n\n${sanitizeTerminalText(content)}`;
	}
	if (output) {
		const lines = sanitizeTerminalText(output).split("\n");
		text += `\n${(expanded ? lines : lines.slice(0, TOOL_PREVIEW_LINES)).join("\n")}`;
		if (!expanded && lines.length > TOOL_PREVIEW_LINES) text += `\n${foldHint(lines.length - TOOL_PREVIEW_LINES)}`;
	}
	return text;
}
