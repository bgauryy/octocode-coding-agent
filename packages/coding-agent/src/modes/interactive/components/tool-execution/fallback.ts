import { type Component, Container, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../../common/src/sanitize.ts";
import { theme } from "../../../../theme/theme.ts";
import { keyHint } from "../keybinding-hints.ts";

const FALLBACK_PREVIEW_LINES = 10;

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
	container.addChild(new Text(theme.fg("warning", `${slot} failed: ${rendererError(error)}`), 0, 0));
	return container;
}

/** Plain-text result preview for tools whose definition has no result renderer, or whose renderer threw. */
export function createResultFallback(output: string, expanded: boolean): Component | undefined {
	if (!output) {
		return undefined;
	}

	const lines = sanitizeTerminalText(output).split("\n");
	const displayLines = expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
	const remaining = lines.length - displayLines.length;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
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
	return `Tool renderer failed (${rendererError(error)}); showing plain output.\n${formatToolExecution(toolName, args, output, expanded)}`;
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
		text += `\n${(expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES)).join("\n")}`;
		if (!expanded && lines.length > FALLBACK_PREVIEW_LINES) {
			text += `\n${theme.fg("muted", `... (${lines.length - FALLBACK_PREVIEW_LINES} more lines)`)} ${keyHint("app.tools.expand", "to expand")}`;
		}
	}
	return text;
}
