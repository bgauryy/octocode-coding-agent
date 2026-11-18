import { Box, type Component } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { ToolRenderContext } from "../../../../core/features/types.ts";
import { resultBlock } from "../../../../octocode/render/tool.ts";
import { outputLanguage } from "../../../../theme/output-style.ts";
import { theme } from "../../../../theme/theme.ts";
import { genericCall } from "./generic.ts";

/** One line naming a renderer failure. Feature renderers are untrusted: the text is sanitized and kept to its first line. */
function rendererError(error: unknown): string {
	let text: string;
	try {
		text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} catch {
		text = "unknown error";
	}
	return (sanitizeTerminalText(text).split("\n")[0] ?? "").trim().slice(0, 200) || "unknown error";
}

/** The generic header of a tool whose definition draws no call, or whose call renderer threw (named in a sub-line). */
export function callFallback(toolName: string, args: unknown, context: ToolRenderContext, error?: unknown): Component {
	const note = error === undefined ? [] : [theme.fg("warning", `Call renderer failed: ${rendererError(error)}`)];
	return genericCall(toolName, args, theme, context, note);
}

/** The plain `⎿` result of a tool whose definition draws no result; undefined when it has no output. */
export function resultFallback(output: string, context: ToolRenderContext): Component | undefined {
	if (!output) return undefined;
	const language = context.isError ? undefined : outputLanguage(output);
	return resultBlock(theme, context, {
		summary: "",
		body: output,
		expanded: context.expanded,
		...(language ? { language } : {}),
	});
}

/**
 * The result of a row whose renderer threw: a failed `⎿` outcome naming the error, then the plain output, so a broken
 * renderer degrades visibly instead of silently. `label` names what failed (`Result`, or the tool).
 */
export function rendererFailure(label: string, error: unknown, output: string, context: ToolRenderContext): Component {
	return resultBlock(theme, context, {
		summary: `${label} renderer failed: ${rendererError(error)}${output ? " · showing plain output" : ""}`,
		body: output,
		error: true,
		stopped: false,
		expanded: context.expanded,
	});
}

/** A row whose components threw while drawing: the generic header and the failure outcome, padded like a tool row. */
export function rendererFailureRow(
	error: unknown,
	toolName: string,
	context: ToolRenderContext,
	output: string,
	pad: number,
): Component {
	const box = new Box(pad, 0);
	box.addChild(callFallback(toolName, context.args, { ...context, lastComponent: undefined }));
	box.addChild(rendererFailure(toolName, error, output, { ...context, lastComponent: undefined }));
	return box;
}
