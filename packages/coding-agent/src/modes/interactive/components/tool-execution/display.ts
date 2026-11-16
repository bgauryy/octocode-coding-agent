import {
	knownToolDisplayBlock,
	type Tone,
	type ToolDisplay,
	type ToolDisplayBlock,
} from "@octocodeai/octocode-contracts";
import { GLYPH, Markdown, type Component, renderChanged, trackRenderChanges } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../../common/src/sanitize.ts";
import { buildToolDisplay } from "../../../../core/application/transcript-display.ts";
import type { ToolDefinition, ToolRenderers } from "../../../../core/features/types.ts";
import { displayText } from "../../../../octocode/render/display.ts";
import { resultBlock, toolHeader } from "../../../../octocode/render/tool.ts";
import { clip, INDENT } from "../../../../octocode/shared/text.ts";
import type { RenderContext } from "../../../../octocode/render/types.ts";
import { outputLanguage } from "../../../../theme/output-style.ts";
import { stateMark } from "../../../../theme/status.ts";
import { getMarkdownTheme, type Theme } from "../../../../theme/theme.ts";
import type { ThemeColor } from "../../../../theme/theme-tokens.ts";
import { renderDiff } from "../../../../theme/diff.ts";

const TONE: Record<Tone, ThemeColor> = {
	normal: "toolOutput",
	muted: "muted",
	success: "success",
	warning: "warning",
	error: "error",
};

/** The spaces the markdown layout pads a line with, before the style resets that end it. */
const PADDING = / +((?:\x1b\[[0-9;]*m)*)$/;

/** A block as styled terminal lines; a block this version does not know shows its text. */
function blockLines(theme: Theme, block: ToolDisplayBlock, width: number): string[] {
	const known = knownToolDisplayBlock(block);
	const plain = (text: string, color: ThemeColor = "toolOutput") =>
		sanitizeTerminalText(text)
			.split("\n")
			.map((line) => theme.fg(color, line.replace(/\t/g, "   ")));
	switch (known?.type) {
		case "diff":
			return known.files.flatMap((file) => {
				const counts = `${file.additions > 0 || file.removals === 0 ? ` ${theme.fg("toolDiffAdded", `+${file.additions}`)}` : ""}${file.removals > 0 ? ` ${theme.fg("toolDiffRemoved", `-${file.removals}`)}` : ""}`;
				const target = `${stateMark(theme, "done")} ${clip(file.operation, 20)} ${theme.fg("mdCode", clip(file.from ? `${file.from} ${GLYPH.arrow} ${file.path}` : file.path, 200))}${counts}`;
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
		case "markdown":
			// Laid out at the width the row has, so a table or a code fence is never re-wrapped.
			return new Markdown(sanitizeTerminalText(known.text).trim(), 0, 0, getMarkdownTheme(theme))
				.render(Math.max(1, width))
				.map((line) => line.replace(PADDING, "$1"));
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
	if (only?.type === "output" || (only?.type === "text" && !only.tone)) {
		const language = only.type === "text" && !outcome?.tone ? outputLanguage(only.text) : undefined;
		return resultBlock(theme, context, {
			...common,
			body: only.text,
			...(language ? { language } : {}),
			tail: only.type === "output" || only.preview === "tail",
			...(only.type === "output" ? { shell: true } : {}),
		});
	}
	const rows = (width: number) => {
		const lines = shown.flatMap((block) => blockLines(theme, block, width));
		return resultBlock(theme, context, { ...common, ...(lines.length ? { lines } : { max: 0 }) });
	};
	// Markdown depends on the width: the rows are built when the width is known. Other blocks do not.
	return shown.some((block) => block.type === "markdown")
		? new WidthResult((width) => rows(width - INDENT.length))
		: rows(0);
}

/** A result whose body is laid out for the width it is drawn at; the drawn rows are kept per width. */
class WidthResult implements Component {
	private drawn: { width: number; lines: string[] } | undefined;
	private readonly build: (width: number) => Component;
	constructor(build: (width: number) => Component) {
		this.build = build;
	}
	render(width: number): string[] {
		if (this.drawn?.width !== width) this.drawn = { width, lines: this.build(width).render(width) };
		return this.drawn.lines;
	}
	invalidate(): void {
		this.drawn = undefined;
		renderChanged(this);
	}
}
trackRenderChanges(WidthResult.prototype);

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
	return buildToolDisplay(input.definition?.display, {
		toolName: input.toolName,
		args: input.args,
		result: input.result,
		text: displayText(input.result),
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
