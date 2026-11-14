import {
	Box,
	type Component,
	Text,
	renderChanged,
	stripTerminalSequences,
	trackRenderChanges,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { Theme } from "../../theme/theme.ts";
import { formatDuration } from "../shared/format.ts";
import { shortPath } from "../../utils/display-path.ts";
import { contentText } from "../shared/util.ts";
import type { UiState } from "../../theme/status.ts";
import { TOOL_PREVIEW_LINES } from "../../theme/theme-tui-helpers.ts";
import { rowMark, uiStateOf } from "./motion.ts";
import { phaseOf, rowState, runStart, track } from "./rows.ts";
import { bodyLines, clip, expandKey, GUTTER, INDENT, plural } from "../shared/text.ts";
import type { ColorToken, Phase, RenderContext } from "./types.ts";

/**
 * Shared tool presentation:
 *
 *   ✓ Name(summary) · 1.2s
 *     ⎿  one-line summary
 *        the whole body up to 12 lines, else a 5-line preview
 *        … +K lines (ctrl+o to expand)
 *
 * The mark is `stateMark`'s: ○ before execution, ◇ breathing once Octocode started the call but its checks or approval
 * still run, a spinner while running (the newest row also has a live 1s clock), ✓ green when done (it flashes once as the call
 * finishes), ✗ red on error and ◼ when stopped or not run. Each state has its own shape, so it reads without colour.
 * Expanded shows every line. Every string drawn here is sanitized: tool arguments and output are untrusted.
 */

/** A body this short shows whole even when collapsed: folding it would hide a few lines behind a one-line hint. */
export const SHOW_ALL_LINES = 12;
/** Header summary budget in characters, before the width clip. */
const SUMMARY_CHARS = 120;
const SUMMARY_CHARS_EXPANDED = 200;

/**
 * Summaries of an interrupted call: Esc (`aborted`, including an MCP call's `MCP request aborted` and the platform's
 * `This operation was aborted` from a connect in progress), a kill, a requested stop, or a call whose model response
 * failed (`Not run`).
 */
const STOPPED =
	/^(?:error:\s*)?(?:mcp )?(?:(?:the |this )?(?:operation|request|run) (?:was )?aborted|aborted|interrupted|cancell?ed|stopped\b|not run\b)/i;

/**
 * One drawn row. `lead` (such as the `⎿` gutter) prefixes its first line only; a wrapped row's continuation lines take
 * `indent`, so the lead is drawn once per block and the text hangs under itself.
 */
export interface Row {
	text: string;
	wrap?: boolean;
	indent?: string;
	lead?: string;
}

export interface Header {
	left: string;
	summary: string;
	right: string;
}

/** The rows of one content version and their lines at the last width they were drawn at. */
interface Version {
	rows: Row[];
	drawn: { width: number; lines: string[] } | undefined;
}

/** Versions kept per component: the collapsed and the expanded view, so ctrl+o back and forth re-wraps nothing. */
const VERSIONS_KEPT = 2;

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		const x = a[index];
		const y = b[index];
		if (x.text !== y.text || x.wrap !== y.wrap || x.indent !== y.indent || x.lead !== y.lead) return false;
	}
	return true;
}

function sameHeader(a: Header | undefined, b: Header | undefined): boolean {
	return a === b || (!!a && !!b && a.left === b.left && a.summary === b.summary && a.right === b.right);
}

function headerLine({ left, summary, right }: Header, width: number): string {
	const room = width - visibleWidth(left) - visibleWidth(right);
	return room >= 4 || !summary
		? truncateToWidth(`${left}${summary ? truncateToWidth(summary, Math.max(0, room), "…") : ""}${right}`, width, "…")
		: truncateToWidth(`${left}${right}`, width, "…");
}

function drawRows(rows: readonly Row[], width: number): string[] {
	const out: string[] = [];
	for (const row of rows) {
		const lead = row.lead ?? "";
		if (!row.wrap) {
			out.push(truncateToWidth(`${lead}${row.text}`, width, "…"));
			continue;
		}
		const indent = row.indent ?? "";
		const wrapped = wrapTextWithAnsi(row.text, Math.max(1, width - visibleWidth(indent)));
		// A width narrower than the indent still gets lines that fit: the indent and text are clipped together.
		(wrapped.length > 0 ? wrapped : [""]).forEach((line, index) => {
			out.push(truncateToWidth(`${index === 0 ? (row.lead ?? indent) : indent}${line}`, width, "…"));
		});
	}
	return out;
}

/**
 * A header and a list of lines clipped to the render width (`wrap` lines wrap instead). octocode-tui draws up to 60
 * frames a second and its Box compares a child's lines by identity, so the output is cached: the header per (text,
 * width), the rows per content version and width, for the last two versions. A `set` with the same content (a redraw of
 * an unchanged row, a clock tick in the header) keeps the drawn rows; `invalidate` (a theme change) drops everything.
 */
export class Lines implements Component {
	private header: Header | undefined;
	private versions: Version[] = [];
	private drawnHeader: { header: Header; width: number; line: string } | undefined;
	private output: { width: number; head: string | undefined; body: string[]; lines: string[] } | undefined;

	set(header: Header | undefined, rows: Row[]): this {
		this.header = header;
		const index = this.versions.findIndex((version) => sameRows(version.rows, rows));
		const version = index === -1 ? { rows, drawn: undefined } : this.versions.splice(index, 1)[0];
		this.versions.unshift(version);
		this.versions.length = Math.min(this.versions.length, VERSIONS_KEPT);
		renderChanged(this);
		return this;
	}

	render(width: number): string[] {
		const version = this.versions[0];
		let body: string[] = [];
		if (version) {
			if (version.drawn?.width !== width) version.drawn = { width, lines: drawRows(version.rows, width) };
			body = version.drawn.lines;
		}
		let head: string | undefined;
		if (this.header) {
			let drawn = this.drawnHeader;
			if (drawn?.width !== width || !sameHeader(drawn.header, this.header)) {
				drawn = { header: this.header, width, line: headerLine(this.header, width) };
				this.drawnHeader = drawn;
			}
			head = drawn.line;
		}
		const output = this.output;
		if (output && output.width === width && output.head === head && output.body === body) return output.lines;
		const lines = head === undefined ? body : [head, ...body];
		this.output = { width, head, body, lines };
		return lines;
	}

	invalidate(): void {
		// A look change restyles every row: older versions would never match again.
		this.versions.length = Math.min(this.versions.length, 1);
		for (const version of this.versions) version.drawn = undefined;
		this.drawnHeader = undefined;
		this.output = undefined;
		renderChanged(this);
	}
}
// Its rows read only what `set` stores (styled when set) and the width: a transcript keeps them between frames.
trackRenderChanges(Lines.prototype);

function lines(context: RenderContext): Lines {
	return context.lastComponent instanceof Lines ? context.lastComponent : new Lines();
}

/** Header sub-lines shown while collapsed, when more than one would be folded. */
const COLLAPSED_SUB_LINES = 3;

/**
 * `<glyph> Name(summary) · 1.2s`, clipped to the width with the time kept. `lines` are extra sub-lines (one per
 * query of a batched call), clipped to the width; collapsed, the first 3 show and `… +N more` counts the rest. Callers
 * sanitize them (they may be styled). Octocode owns completed execution timing; while running, the newest row shows the time
 * since its run began (`timed` records it, so the tool must be wrapped by `timed`), and a row still waiting for its
 * checks, approval or lock says `waiting`. Custom messages can supply a duration.
 */
export function toolHeader(
	theme: Theme,
	context: RenderContext,
	name: string,
	summary: string,
	options: { durationMs?: number; meta?: string; lines?: string[]; state?: UiState } = {},
): Component {
	const base = phaseOf(context);
	const state = track(context, base);
	const start = base === "running" ? runStart(context, state) : undefined;
	const waiting = base === "running" && start === undefined;
	const phase: Phase = base === "error" && state.stopped ? "stopped" : waiting ? "pending" : base;
	const measured = state.ticking && start !== undefined ? Date.now() - start : undefined;
	const duration = context.durationMs ?? options.durationMs ?? measured;
	const finished = phase === "done" || phase === "error" || phase === "stopped";
	const time = waiting
		? "waiting"
		: duration !== undefined && phase !== "pending"
			? formatDuration(duration, true)
			: "";
	const meta = [options.meta ? clip(options.meta, 60) : "", time, finished ? (state.waits ?? "") : ""].filter(Boolean);
	const text = clip(summary, context.expanded ? SUMMARY_CHARS_EXPANDED : SUMMARY_CHARS);
	const mark = rowMark(theme, context, state, options.state ?? (waiting ? "waiting" : uiStateOf(phase)));
	const left = `${mark} ${theme.fg("toolTitle", theme.bold(clip(name, 60)))}${text ? theme.fg("muted", "(") : ""}`;
	const right = `${text ? theme.fg("muted", ")") : ""}${meta.length > 0 ? theme.fg("dim", ` · ${meta.join(" · ")}`) : ""}`;
	const sub = options.lines ?? [];
	// Folding one line would cost the line it saves.
	const folded = !context.expanded && sub.length > COLLAPSED_SUB_LINES + 1;
	const rows = (folded ? sub.slice(0, COLLAPSED_SUB_LINES) : sub).map((line) => ({ text: `  ${line}` }));
	if (folded)
		rows.push({
			text: `  ${theme.fg("dim", `… +${sub.length - COLLAPSED_SUB_LINES} more (${expandKey()} to expand)`)}`,
		});
	return lines(context).set({ left, summary: text ? theme.fg("muted", text) : "", right }, rows);
}

interface ResultBlockOptions {
	/** The `⎿` line. Sanitized; only its first line is shown. */
	summary: string;
	summaryColor?: ColorToken;
	/** Raw output: sanitized and coloured here. */
	body?: string;
	/** How many lines the whole body has when `body` holds only its tail (a collapsed command output), for `+K lines`. */
	totalLines?: number;
	/** Pre-styled body lines (for diffs); the caller sanitized their text. Used instead of `body`. */
	lines?: string[];
	/** Pre-styled lines shown before the body only when expanded (a subagent's prompt); the caller sanitized them. */
	preface?: string[];
	/** What the collapsed hint calls the preface (`… +2 lines · prompt`); default `more`. */
	prefaceLabel?: string;
	/** Preview lines while collapsed (default 3). */
	max?: number;
	/** Preview the last lines instead of the first (command output). */
	tail?: boolean;
	/** Colour as an error; defaults to `context.isError`. */
	error?: boolean;
	/** Draw as interrupted rather than failed; defaults to an error whose summary says it was aborted or stopped. */
	stopped?: boolean;
	/** Where the full output was saved; shown short, and only when expanded. */
	spill?: string;
	/** The label before `spill` (default `saved`; `log` for a job's log). */
	spillLabel?: string;
	/** The pre-run waits `timingOf` read from the details; shown in the header. */
	waits?: string;
	/** Expanded view; defaults to `context.expanded` (pass renderResult's `options.expanded`). */
	expanded?: boolean;
}

/** `  ⎿  summary`, then a preview of the body and `… +K lines (ctrl+o to expand)`; the whole body when expanded. */
export function resultBlock(theme: Theme, context: RenderContext, options: ResultBlockOptions): Component {
	const state = rowState(context);
	const waitsChanged = options.waits !== undefined && state.waits !== options.waits;
	if (waitsChanged) {
		state.waits = options.waits;
		// The header already drew without these waits: redraw once, after this pass.
		if (context.invalidate) {
			const invalidate = context.invalidate;
			queueMicrotask(() => invalidate());
		}
	}
	const summary = clip(options.summary, 400);
	const failed = options.error ?? context.isError === true;
	const stopped = options.stopped ?? (failed && STOPPED.test(summary));
	if (stopped && !state.stopped) {
		state.stopped = true;
		// The header may have drawn a failure glyph already: redraw it once as interrupted.
		if (context.invalidate) {
			const invalidate = context.invalidate;
			queueMicrotask(() => invalidate());
		}
	}
	const error = failed && !stopped;
	const color = stopped ? "warning" : error ? "error" : "toolOutput";
	const summaryColor = stopped || error ? color : (options.summaryColor ?? color);
	const rows: Row[] = [];
	if (summary)
		rows.push({
			lead: theme.fg("dim", GUTTER),
			text: theme.fg(
				summaryColor,
				error && !/^(error|failed)\b|\bfailed\b/i.test(summary)
					? `Error: ${summary}`
					: stopped
						? summary.replace(/^error:\s*/i, "")
						: summary,
			),
			// An error or stop explains what to do next: wrap it whole instead of clipping it to one row.
			...(error || stopped ? { wrap: true, indent: INDENT } : {}),
		});
	// Raw body lines are coloured only where shown: a collapsed preview colours its few lines, not the whole output.
	const raw = options.lines ? undefined : options.body ? bodyLines(options.body) : [];
	const paint = (line: string) => (raw ? theme.fg(color, line) : line);
	const body = options.lines ?? raw!;
	const max = Math.max(0, options.max ?? TOOL_PREVIEW_LINES);
	// The `⎿` gutter leads the first row of the block only; every later row (and each wrapped continuation) hangs under the text.
	const lead = () => (rows.length === 0 ? theme.fg("dim", GUTTER) : INDENT);
	const hang = (text: string): Row => ({ text, wrap: true, indent: INDENT, lead: lead() });
	const preface = options.preface ?? [];
	if (options.expanded ?? context.expanded) {
		for (const line of preface) rows.push(hang(line));
		for (const line of body) rows.push(hang(paint(line)));
		if (options.spill)
			rows.push({
				text: theme.fg("dim", `${options.spillLabel ?? "saved"}: ${clip(shortPath(options.spill), 300)}`),
				// A path is only useful whole: wrap it under the label instead of cutting it at the row's width.
				lead: INDENT,
				wrap: true,
				indent: INDENT,
			});
	} else {
		// Blank lines waste preview rows; they still count as hidden and show when expanded.
		const filled = body.filter((line) => (raw ? line : stripTerminalSequences(line)).trim() !== "");
		const short =
			max > 0 && preface.length === 0 && filled.length <= SHOW_ALL_LINES && (options.totalLines ?? 0) <= body.length;
		const limit = short ? filled.length : max;
		const shown = (options.tail ? filled.slice(Math.max(0, filled.length - limit)) : filled.slice(0, limit)).map(paint);
		// Blank lines are not counted as hidden when nothing else is: a short body is shown whole.
		const hidden = short ? 0 : Math.max(options.totalLines ?? 0, body.length) - shown.length;
		// The preface is named, not counted: `+2 lines` must mean two more lines of the body.
		const more = preface.length > 0 ? ` · ${options.prefaceLabel ?? "more"}` : "";
		const folded = hidden > 0 || more !== "";
		// Summary-only tools (`⎿  Read 51 lines (ctrl+o to expand)`), or a saved path that only the expanded view shows.
		if (summary && (max === 0 ? folded || options.spill : !folded && options.spill))
			rows[0] = {
				...rows[0],
				text: `${rows[0].text}${theme.fg("dim", `${max === 0 ? more : ""} (${expandKey()} to expand)`)}`,
			};
		if (max === 0 && summary) return lines(context).set(undefined, rows);
		// A tail preview hides the lines before it: say so, so the hint does not read as more output below.
		const hiddenText = options.tail
			? `+${hidden} earlier ${hidden === 1 ? "line" : "lines"}`
			: `+${plural(hidden, "line")}`;
		const hintText = theme.fg(
			"dim",
			`${hidden > 0 ? `… ${hiddenText}${more}` : `… ${options.prefaceLabel ?? "more"}`} (${expandKey()} to expand)`,
		);
		if (folded && options.tail) rows.push({ text: hintText, lead: lead() });
		for (const line of shown) rows.push({ text: line, lead: lead() });
		if (folded && !options.tail) rows.push({ text: hintText, lead: lead() });
	}
	return lines(context).set(undefined, rows);
}

/** The file `capOutputToFile` (shared/spill.ts) saved the full output to, read back from its note. */
export function spillPath(text: string): string | undefined {
	return /Full output: (.+?); search it or read it by line range\.\]\s*$/.exec(text)?.[1];
}

/** Already-styled lines as one component, padded like a tool row (custom messages are drawn flush left). */
export function textBlock(text: string, padX = 1): Component {
	const box = new Box(padX, 0);
	box.addChild(new Text(text, 0, 0));
	return box;
}

export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return sanitizeTerminalText(contentText(result.content, { image: "[image]" }));
}
