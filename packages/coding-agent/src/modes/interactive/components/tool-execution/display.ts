import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import {
	knownToolDisplayBlock,
	type Tone,
	type ToolDisplay,
	type ToolDisplayBlock,
} from "@octocodeai/octocode-contracts";
import type { Component } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../../common/src/sanitize.ts";
import { buildToolDisplay } from "../../../../core/application/transcript-display.ts";
import type { ToolDefinition, ToolRenderers } from "../../../../core/features/types.ts";
import { resultBlock, toolHeader } from "../../../../octocode/render/tool.ts";
import { clip } from "../../../../octocode/shared/text.ts";
import type { RenderContext } from "../../../../octocode/render/types.ts";
import { stateMark } from "../../../../theme/status.ts";
import type { Theme } from "../../../../theme/theme.ts";
import type { ThemeColor } from "../../../../theme/theme-tokens.ts";
import { renderDiff } from "../../../../theme/diff.ts";

const TONE: Record<Tone, ThemeColor> = {
	normal: "toolOutput",
	muted: "muted",
	success: "success",
	warning: "warning",
	error: "error",
};

/** A block as styled terminal lines; a block this version does not know shows its text. */
function blockLines(theme: Theme, block: ToolDisplayBlock): string[] {
	const known = knownToolDisplayBlock(block);
	const plain = (text: string, color: ThemeColor = "toolOutput") =>
		sanitizeTerminalText(text)
			.split("\n")
			.map((line) => theme.fg(color, line.replace(/\t/g, "   ")));
	switch (known?.type) {
		case "diff":
			return known.files.flatMap((file) => {
				const counts = `${file.additions > 0 || file.removals === 0 ? ` ${theme.fg("toolDiffAdded", `+${file.additions}`)}` : ""}${file.removals > 0 ? ` ${theme.fg("toolDiffRemoved", `-${file.removals}`)}` : ""}`;
				const target = `${stateMark(theme, "done")} ${clip(file.operation, 20)} ${theme.fg("mdCode", clip(file.from ? `${file.from} → ${file.path}` : file.path, 200))}${counts}`;
				return [
					target,
					...(file.patch ? renderDiff(sanitizeTerminalText(file.patch), { filePath: file.path }).split("\n") : []),
				];
			});
		case "list":
			return known.items.flatMap((item) => [
				`${item.state ? `${stateMark(theme, item.state)} ` : ""}${theme.fg(item.tone ? TONE[item.tone] : "toolOutput", clip(sanitizeTerminalText(item.text), 300))}`,
				...(item.detail ? plain(item.detail, "muted").map((line) => `  ${line}`) : []),
			]);
		case "fields":
			return known.entries.map(
				(entry) =>
					`${theme.fg("muted", `${clip(sanitizeTerminalText(entry.label), 60)}:`)} ${theme.fg("toolOutput", clip(sanitizeTerminalText(entry.value), 300))}`,
			);
		case "text":
			return plain(known.text, known.tone ? TONE[known.tone] : "toolOutput");
		case "path":
			return [];
		default:
			return plain(block.text);
	}
}

/** The header row of a call: `<mark> Title(summary) · meta`, with its sub-lines. */
function renderDisplayCall(display: ToolDisplay, theme: Theme, context: RenderContext): Component {
	return toolHeader(theme, context, display.title, sanitizeTerminalText(display.summary ?? ""), {
		...(display.meta?.length ? { meta: sanitizeTerminalText(display.meta.join(" · ")) } : {}),
		...(display.subjects?.length ? { lines: display.subjects.map((line) => sanitizeTerminalText(line)) } : {}),
		...(display.state ? { state: display.state } : {}),
	});
}

/** The result rows: the `⎿` outcome, then the blocks, collapsed to a preview until expanded. */
function renderDisplayResult(display: ToolDisplay, theme: Theme, context: RenderContext, expanded: boolean): Component {
	const blocks = [...(expanded ? (display.preface ?? []) : []), ...display.blocks];
	const saved = blocks.map(knownToolDisplayBlock).find((block) => block?.type === "path");
	const shown = blocks.filter((block) => block.type !== "path");
	const outcome = display.outcome;
	const common = {
		summary: sanitizeTerminalText(outcome?.text ?? ""),
		...(outcome?.tone && outcome.tone !== "error" ? { summaryColor: TONE[outcome.tone] } : {}),
		...(outcome ? { error: outcome.tone === "error" } : {}),
		...(outcome?.stopped ? { stopped: true } : {}),
		...(saved?.type === "path" ? { spill: saved.path, spillLabel: saved.label } : {}),
		expanded,
	};
	const only = shown.length === 1 ? knownToolDisplayBlock(shown[0]) : undefined;
	if (only?.type === "output" || (only?.type === "text" && !only.tone))
		return resultBlock(theme, context, {
			...common,
			body: only.text,
			tail: only.type === "output" || only.preview === "tail",
		});
	const lines = shown.flatMap((block) => blockLines(theme, block));
	return resultBlock(theme, context, { ...common, ...(lines.length ? { lines } : { max: 0 }) });
}

/** The display a row shows: the host's when the row has it, otherwise built here from the same pure function. */
export function rowDisplay(input: {
	live?: ToolDisplay;
	definition?: ToolRenderers;
	toolName: string;
	args: unknown;
	result?: { content: unknown[]; isError?: boolean };
	isPartial: boolean;
}): ToolDisplay {
	if (input.live) return input.live;
	const status = input.isPartial ? "running" : input.result?.isError ? "failed" : "completed";
	const content = (input.result?.content ?? []) as AgentToolResult["content"];
	const text = content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	return buildToolDisplay(input.definition?.display, {
		toolName: input.toolName,
		args: input.args,
		result: input.result,
		text,
		status,
	});
}

/**
 * The renderers a row uses: the tool's own while it still has them, else ones that draw its display. Undefined
 * keeps the generic row for a tool with neither.
 */
export function displayRenderers(
	definition: ToolRenderers | ToolDefinition<any, any> | undefined,
	display: () => ToolDisplay,
): ToolRenderers | undefined {
	if (!definition?.display || definition.renderCall || definition.renderResult) return definition;
	return {
		...definition,
		renderCall: (_args, theme, context) => renderDisplayCall(display(), theme, context),
		renderResult: (_result, options, theme, context) =>
			renderDisplayResult(display(), theme, context, options.expanded),
	};
}
