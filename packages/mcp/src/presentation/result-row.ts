import { toolProgressFraction, toolProgressText, type ApplicationToolProgress } from "@octocodeai/octocode-contracts";
import { Container, Spacer, Text, VisualLinePreview } from "@octocodeai/octocode-tui";
import { visibleControls } from "../../../common/src/sanitize.ts";
import { hostRender, hostUi } from "../host.ts";
import type { McpToolRenderers } from "../host/types.ts";
import type { McpToolDetails } from "../tools.ts";
import { colorJson, isJsonDocument } from "../../../common/src/json-color.ts";

const OUTPUT_PREVIEW_LINES = 5;
/** A collapsed JSON result colours this many characters: more than the preview's wrapped lines can show. */
const JSON_PREVIEW_CHARS = 8192;
/** The argument names a file-reading call puts its path in. */
const PATH_ARGS = ["path", "fullPath", "filePath", "file"];

/** The file a call named: a path argument of its own or of its first query (`queries: [{ path }]`). */
function calledPath(args: unknown): string | undefined {
	const read = (value: unknown): string | undefined => {
		if (!value || typeof value !== "object") return undefined;
		for (const name of PATH_ARGS) {
			const path = (value as Record<string, unknown>)[name];
			if (typeof path === "string" && path) return path;
		}
		return undefined;
	};
	const queries = (args as { queries?: unknown } | null | undefined)?.queries;
	return read(args) ?? (Array.isArray(queries) ? read(queries[0]) : undefined);
}
const METER_CELLS = 20;

/** `██████░░░░ 3/10 (30%) · message`; without a known total only the text. */
function progressMeter(progress: ApplicationToolProgress): string {
	const fraction = toolProgressFraction(progress);
	const text = visibleControls(toolProgressText(progress)).replace(/\s+/g, " ");
	if (fraction === undefined) return text;
	const filled = Math.round(fraction * METER_CELLS);
	return `${"█".repeat(filled)}${"░".repeat(METER_CELLS - filled)} ${text}`;
}

/** The result row of an MCP tool: a progress meter while it runs, then its output (JSON coloured), previewed until expanded. */
export const renderMcpResult: NonNullable<McpToolRenderers["renderResult"]> = (result, options, theme, context) => {
	const component = (context.lastComponent as Container | undefined) ?? new Container();
	component.clear();
	// A running call that reports progress shows a meter; its text update says the same in words.
	if (context.isPartial && result.progress) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("muted", progressMeter(result.progress)), 0, 0));
		return component;
	}
	const output = hostRender().getTextOutput(result, context.showImages).trim();
	if (!output) return component;
	const styled =
		(!context.isError && isJsonDocument(output)
			? colorJson(output, theme, options.expanded, options.expanded ? Infinity : JSON_PREVIEW_CHARS)
			: context.isError
				? undefined
				: hostRender().colorOutput(theme, output, {
						path: calledPath(context.args),
						expanded: options.expanded,
						previewLines: OUTPUT_PREVIEW_LINES,
					})) ??
		output
			.replace(/\t/g, "   ")
			.split("\n")
			.map((line) => theme.fg(context.isError ? "error" : "toolOutput", line))
			.join("\n");
	component.addChild(new Spacer(1));
	if (options.expanded) {
		component.addChild(new Text(styled, 0, 0));
	} else {
		// Limit wrapped lines, not logical ones: MCP results are often one long JSON line.
		component.addChild(
			new VisualLinePreview({
				text: styled,
				maxVisualLines: OUTPUT_PREVIEW_LINES,
				keep: "start",
				formatHint: (hidden) =>
					`${theme.fg("muted", `... (${hidden} more lines,`)} ${hostUi().keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
			}),
		);
		const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
		if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
	}
	return component;
};
