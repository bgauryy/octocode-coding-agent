import { Box, type Component, Lines, type Row, Text, stripTerminalSequences } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { Theme } from "../../theme/theme.ts";
import { styleShellLines } from "../../theme/output-style.ts";
import { formatDuration } from "../shared/format.ts";
import { shortPath } from "../../utils/display-path.ts";
import { contentText } from "../shared/util.ts";
import { highlightCode, TOOL_PREVIEW_LINES } from "../../theme/theme-tui-helpers.ts";
import { rowMark, uiStateOf } from "./motion.ts";
import { phaseOf, rowState, runStart, track } from "./rows.ts";
import { bodyLines, clip, expandHint, GUTTER, INDENT, linkPath, plural } from "../shared/text.ts";
import type { UiState } from "../../theme/status.ts";
import { type ColorToken, type Phase, type RenderContext, STOPPED_COLOR } from "./types.ts";

/**
 * Shared tool presentation:
 *
 *   ◉ Name(summary) · 1.2s
 *     ⎿  one-line summary (ctrl+o to expand)
 *
 * A finished row closes to its summary line. While it runs, or when it failed, it shows the whole body up to 12 lines,
 * else a 5-line preview and `… +K lines (ctrl+o to expand)`; a renderer may pass its own preview size.
 *
 * The mark is the row's still state light (`rowMark`): `○` before execution, `◐` once Octocode started the call but its
 * checks or approval still run, grey `⏺` while running (the row also has a live 1s clock), green `◉` when done, red
 * `⊗` on error and `⊘` when stopped. Nothing on a row moves but its clock.
 * Expanded shows every line. Every string drawn here is sanitized: tool arguments and output are untrusted.
 */

/** A body this short shows whole even when collapsed: folding it would hide a few lines behind a one-line hint. */
export const SHOW_ALL_LINES = 12;
/** Header summary budget in characters, before the width clip. */
const SUMMARY_CHARS = 120;
const SUMMARY_CHARS_EXPANDED = 200;
/** A finished row names its duration from this long: a fast call's `21ms` is noise. A running row keeps its live clock. */
const SHOW_DURATION_MS = 1000;

/**
 * Summaries of an interrupted call: Esc (`aborted`, including an MCP call's `MCP request aborted` and the platform's
 * `This operation was aborted` from a connect in progress), a kill, a requested stop, or a call whose model response
 * failed (`Not run`).
 */
const STOPPED =
	/^(?:error:\s*)?(?:mcp )?(?:(?:the |this )?(?:operation|request|run) (?:was )?aborted|aborted|interrupted|cancell?ed|stopped\b|not run\b)/i;

function lines(context: RenderContext): Lines {
	return context.lastComponent instanceof Lines ? context.lastComponent : new Lines();
}

/** `text`, then the expand hint when the key is bound. */
function joinHint(text: string): string {
	const hint = expandHint();
	return hint ? `${text} ${hint}` : text;
}

/** Header sub-lines shown while collapsed, when more than one would be folded. */
const COLLAPSED_SUB_LINES = 3;

/**
 * `<glyph> Name(summary) · meta · 1.2s` (a finished row's time from 1s on), clipped to the width with the time kept. `lines` are extra sub-lines (one per
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
	options: {
		durationMs?: number;
		meta?: string;
		lines?: string[];
		state?: UiState;
		/** The summary already styled (the caller sanitized it), drawn in the parentheses, and styled text after them. */
		styled?: { summary: string; meta?: string };
		/** A file path inside `summary`: linked to the file where the terminal supports it. */
		link?: string;
	} = {},
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
		: duration !== undefined && phase !== "pending" && (!finished || duration >= SHOW_DURATION_MS)
			? formatDuration(duration, true)
			: "";
	const times = [time, finished ? (state.waits ?? "") : ""].filter(Boolean);
	const text = options.styled ? "" : clip(summary, context.expanded ? SUMMARY_CHARS_EXPANDED : SUMMARY_CHARS);
	const mark = rowMark(theme, options.state ?? (waiting ? "waiting" : uiStateOf(phase)));
	const left = `${mark} ${theme.fg("toolTitle", theme.bold(clip(name, 60)))}`;
	const right = times.length > 0 ? theme.fg("dim", ` · ${times.join(" · ")}`) : "";
	const meta = `${options.styled?.meta ? `${theme.fg("dim", " · ")}${options.styled.meta}` : ""}${options.meta ? theme.fg("dim", ` · ${clip(options.meta, 60)}`) : ""}`;
	const sub = options.lines ?? [];
	// Folding one line would cost the line it saves.
	const folded = !context.expanded && sub.length > COLLAPSED_SUB_LINES + 1;
	const rows = (folded ? sub.slice(0, COLLAPSED_SUB_LINES) : sub).map((line) => ({ text: `  ${line}` }));
	if (folded)
		rows.push({
			text: `  ${theme.fg("dim", joinHint(`… +${sub.length - COLLAPSED_SUB_LINES} more`))}`,
		});
	return lines(context).set(
		{
			left,
			summary: options.styled?.summary ?? (text ? theme.fg("muted", linkIn(text, options.link, context.cwd)) : ""),
			right,
			meta,
			...(options.styled || text ? { parens: [theme.fg("muted", "("), theme.fg("muted", ")")] as const } : {}),
		},
		rows,
	);
}

/** `text` with the first occurrence of `path` linked to the file; unchanged when the path was clipped away. */
function linkIn(text: string, path: string | undefined, cwd: string | undefined): string {
	const at = path ? text.indexOf(path) : -1;
	if (!path || at < 0) return text;
	return `${text.slice(0, at)}${linkPath(path, path, cwd)}${text.slice(at + path.length)}`;
}

interface ResultBlockOptions {
	/** The `⎿` line. Sanitized; only its first line is shown. */
	summary: string;
	/**
	 * Parts after the summary on its row, joined with ` · ` (`general-0001`, `14 tool calls`). Where the row is too narrow
	 * the last parts drop whole, as a header's meta does, instead of the row being cut mid-word.
	 */
	summaryMeta?: readonly string[];
	/** The `⎿` line already styled (the caller sanitized its text), drawn instead of `summary` unless the row failed or stopped. */
	styledSummary?: string;
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
	/** Shell output: failure and warning lines, `path:line` heads and a unified diff are coloured as such. */
	shell?: boolean;
	/**
	 * Preview lines while collapsed. Default: none once the call finished, so the row closes to its summary line (ctrl+o
	 * opens it; a lone line without a summary stays); a 5-line preview while it runs or when it failed.
	 */
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
	/** Highlight the body as this language (`json`, `yaml`); not for an error or a shell body. */
	language?: string;
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
	const meta = (options.summaryMeta ?? []).filter(Boolean);
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
	const color = stopped ? STOPPED_COLOR : error ? "error" : "toolOutput";
	const summaryColor = stopped || error ? color : (options.summaryColor ?? color);
	const rows: Row[] = [];
	if (summary && options.styledSummary && !error && !stopped)
		rows.push({ lead: theme.fg("dim", GUTTER), text: options.styledSummary });
	else if (summary) {
		// An error or stop explains what to do next: wrap it whole instead of clipping it to one row.
		const wrap = error || stopped;
		const text = wrap ? [summary, ...meta].join(" · ") : summary;
		rows.push({
			lead: theme.fg("dim", GUTTER),
			text: theme.fg(
				summaryColor,
				error && !/^(error|failed)\b|\bfailed\b/i.test(text)
					? `Error: ${text}`
					: stopped
						? text.replace(/^error:\s*/i, "")
						: text,
			),
			...(wrap ? { wrap: true, indent: INDENT } : {}),
			...(!wrap && meta.length > 0 ? { meta: meta.map((part) => theme.fg(summaryColor, ` · ${part}`)) } : {}),
		});
	}
	// Raw body lines are coloured only where shown: a collapsed preview colours its few lines, not the whole output.
	const rawLines = options.lines ? undefined : options.body ? bodyLines(options.body) : [];
	const styled = options.shell && rawLines ? styleShellLines(theme, rawLines, color) : undefined;
	const colored =
		!styled && !error && !stopped && options.language && rawLines
			? highlightCode(rawLines.join("\n"), options.language, theme)
			: undefined;
	const painted = colored?.length === rawLines?.length ? colored : undefined;
	const raw = styled || painted ? undefined : rawLines;
	const paint = (line: string) => (raw ? theme.fg(color, line) : line);
	const body = options.lines ?? styled ?? painted ?? raw!;
	// The `⎿` gutter leads the first row of the block only; every later row (and each wrapped continuation) hangs under the text.
	const lead = () => (rows.length === 0 ? theme.fg("dim", GUTTER) : INDENT);
	const hang = (text: string): Row => ({ text, wrap: true, indent: INDENT, lead: lead() });
	const preface = options.preface ?? [];
	if (options.expanded ?? context.expanded) {
		for (const line of preface) rows.push(hang(line));
		for (const line of body) rows.push(hang(paint(line)));
		if (options.spill)
			rows.push({
				text: theme.fg(
					"dim",
					`${options.spillLabel ?? "saved"}: ${linkPath(clip(shortPath(options.spill), 300), options.spill, context.cwd)}`,
				),
				// A path is only useful whole: wrap it under the label instead of cutting it at the row's width.
				lead: INDENT,
				wrap: true,
				indent: INDENT,
			});
	} else {
		// Blank lines waste preview rows; they still count as hidden and show when expanded.
		const filled = body.filter((line) => (raw ? line : stripTerminalSequences(line)).trim() !== "");
		// A finished row closes; without a summary its one line stays, since a hint would take the same row.
		const closed = summary || filled.length > 1 || preface.length > 0 ? 0 : 1;
		const max = Math.max(0, options.max ?? (context.isPartial || failed ? TOOL_PREVIEW_LINES : closed));
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
		if (summary && (max === 0 ? folded || options.spill : !folded && options.spill)) {
			const hint = theme.fg("dim", joinHint(max === 0 ? more : ""));
			// The hint ends the row: after the meta parts, and dropped with them first.
			const first = rows[0];
			rows[0] = first.meta ? { ...first, meta: [...first.meta, hint] } : { ...first, text: `${first.text}${hint}` };
		}
		if (max === 0 && summary) return lines(context).set(undefined, rows);
		// A tail preview hides the lines before it: say so, so the hint does not read as more output below.
		const hiddenText = options.tail
			? `+${hidden} earlier ${hidden === 1 ? "line" : "lines"}`
			: `+${plural(hidden, "line")}`;
		const hintText = theme.fg(
			"dim",
			joinHint(hidden > 0 ? `… ${hiddenText}${more}` : `… ${options.prefaceLabel ?? "more"}`),
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
