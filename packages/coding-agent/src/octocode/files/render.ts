import { fileChanges } from "../tool-input/file-input.ts";
import { Box, type Component, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { renderDiff } from "../../theme/diff.ts";
import type { Theme } from "../../theme/theme.ts";
import { SHOW_ALL_LINES, resultBlock, resultText, toolHeader } from "../render/tool.ts";
import { contentText } from "../shared/util.ts";
import { clip, expandHint, plural } from "../shared/text.ts";
import { isInformativeReason } from "../shared/reason.ts";
import type { RenderContext } from "../render/types.ts";
import { timingOf } from "../render/rows.ts";
import { stateMark } from "../../theme/status.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { parseJobMessage } from "./bash-jobs/message.ts";
import { bashOutcome, diffStats, querySize, type BashDetails, type QueryOutcome } from "./outcome.ts";

/**
 * How the files tools draw: `Bash(cmd)` / `⎿  exit 0 · 12 lines` and the last lines, `File(edit a.ts)` /
 * `✓ edit a.ts +4 -1` with a short diff, and the background job report.
 */
/** A result as a renderer sees it. */
interface ToolResultView {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

/** Keep host notices visible even when command output is collapsed. */
function bashNotices(body: Component, details: BashDetails, theme: Theme): Component {
	if (!details.notices?.length) return body;
	const box = new Box(0, 0);
	box.addChild(body);
	box.addChild(
		new Text(
			details.notices
				.map((notice) =>
					theme.fg(
						"toolOutput",
						sanitizeTerminalText(notice)
							.split("\n")
							.map((line) => `    ${line}`)
							.join("\n"),
					),
				)
				.join("\n"),
			0,
			0,
		),
	);
	return box;
}

export function renderBashResult(
	result: ToolResultView,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext & { isError: boolean },
): Component {
	const details = (result.details ?? {}) as BashDetails;
	const text = contentText(result.content);
	const timing = timingOf(details);
	if (details.job && !context.isError) {
		return bashNotices(
			resultBlock(theme, context, {
				summary: `job ${details.job} ${details.moved ? "moved to the background" : "started"} (pid ${details.pid ?? "?"})`,
				max: 0,
				expanded: options.expanded,
				...(details.log ? { spill: details.log, spillLabel: "log" } : {}),
				...timing,
			}),
			details,
			theme,
		);
	}
	// Collapsed, only the tail is sanitized and split: a streaming command redraws on every update. The tail is as long
	// as the longest output shown whole, so a short output is not folded.
	const outcome = bashOutcome(
		text,
		context.isError,
		options.isPartial,
		options.expanded ? undefined : SHOW_ALL_LINES,
		details,
	);
	const spill = details.fullOutputPath ?? outcome.spill;
	const total = outcome.lines !== undefined ? { totalLines: outcome.lines } : {};
	return bashNotices(
		resultBlock(theme, context, {
			summary: outcome.summary,
			body: outcome.body,
			...total,
			tail: true,
			shell: true,
			expanded: options.expanded,
			...(spill ? { spill } : {}),
			...timing,
		}),
		details,
		theme,
	);
}

/** A finished background job: `✓ Bash(bash-1: yarn build) · background`, `↳ <why>`, `⎿  finished after 3s`, its output tail; the status header names its log (format: `bash-jobs/message.ts`). */
export function renderJobMessage(text: string, expanded: boolean, theme: Theme, outputPad = 1): Component {
	const { head, why, log, rest } = parseJobMessage(text);
	const ok = / finished after /.test(head);
	const stopped = !ok && / stopped \(/.test(head); // killed by the user or at shutdown: interrupted, not failed
	// "Background bash bash-1 finished after 3s: yarn build" → `✓ Bash(bash-1: yarn build) · background` / `⎿ finished after 3s`.
	const parts = /^Background bash (\S+) (.+?): (.*)$/.exec(head);
	const context: RenderContext = { isPartial: false, isError: !ok, expanded, state: stopped ? { stopped: true } : {} };
	const box = new Box(outputPad, 0); // custom messages are drawn flush left; pad them like a tool row
	const lines = isInformativeReason(why) ? [theme.fg("toolReason", `↳ ${clip(sanitizeTerminalText(why), 200)}`)] : [];
	box.addChild(
		toolHeader(theme, context, "Bash", parts ? `${parts[1]}: ${parts[3]}` : head, { lines, meta: "background" }),
	);
	box.addChild(
		resultBlock(theme, context, {
			summary: parts?.[2] ?? head,
			body: rest.join("\n"),
			tail: true,
			error: !ok,
			stopped,
			...(log ? { spill: log, spillLabel: "log" } : {}),
		}),
	);
	return box;
}

/** Diff lines shown per file before expanding. */
const DIFF_PREVIEW_LINES = 6;

/** Diff lines rendered for a collapsed change: enough for the preview, or for a diff short enough to show whole. */
const DIFF_HEAD_LINES = SHOW_ALL_LINES + DIFF_PREVIEW_LINES;
/** A change block is rendered whole, so its lines pair up for word emphasis as they do expanded; up to this many more. */
const DIFF_HEAD_BLOCK_LINES = 200;

/** The start of `diff`, cut after a whole change block. */
function diffHead(diff: string): string {
	const lines = diff.split("\n");
	if (lines.length <= DIFF_HEAD_LINES) return diff;
	let end = DIFF_HEAD_LINES;
	while (end < lines.length && end < DIFF_HEAD_LINES + DIFF_HEAD_BLOCK_LINES && /^[+-]/.test(lines[end])) end++;
	return lines.slice(0, end).join("\n");
}

type FileArgs = {
	patch?: string;
	reason?: string;
	queries?: Array<{
		type?: string;
		path?: string;
		movePath?: string;
		reason?: string;
		edits?: unknown[];
		content?: string;
	}>;
};

export function renderFileCall(args: FileArgs, theme: Theme, context: RenderContext): Component {
	const queries = fileChanges(args) as NonNullable<typeof args.queries>;
	const describe = (query: (typeof queries)[number] | undefined) =>
		clip(
			`${query?.type ?? "…"} ${query?.path ?? ""}${query?.movePath ? ` → ${query.movePath}` : ""}${querySize(query)}`,
			200,
		);
	// One change: File(edit src/a.ts · 2 edits). Several: File(3 changes) with a sub-line each. Reasons are drawn once, by `reasonRow`.
	if (queries.length <= 1) return toolHeader(theme, context, "File", queries.length === 1 ? describe(queries[0]) : "");
	const lines = queries.map(
		(query) =>
			`${theme.fg("accent", clip(query?.type ?? "…", 20))} ${theme.fg("mdCode", clip(query?.path ?? "", 200))}${theme.fg("dim", querySize(query))}`,
	);
	return toolHeader(theme, context, "File", `${queries.length} changes`, { lines });
}

export function renderFileResult(
	result: ToolResultView,
	{ expanded }: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	const outcomes = (
		isRecord(result.details) && Array.isArray(result.details.outcomes) ? result.details.outcomes : []
	) as QueryOutcome[];
	const timing = timingOf(result.details);
	if (outcomes.length === 0) {
		// Every change failed (or was rejected): the tool threw with the numbered outcome list.
		const [summary = "", ...rest] = resultText(result)
			.split("\n")
			.map((line) => line.replace(/^\d+\. FAILED /, ""));
		return resultBlock(theme, context, { summary, body: rest.join("\n"), ...timing });
	}
	const heads: string[] = [];
	const details: string[] = [];
	let diffLines = 0;
	for (const outcome of outcomes) {
		const stats = outcome.diff ? diffStats(outcome.diff) : undefined;
		const counts = stats
			? [
					stats.added > 0 || stats.removed === 0 ? ` ${theme.fg("toolDiffAdded", `+${stats.added}`)}` : "",
					stats.removed > 0 ? ` ${theme.fg("toolDiffRemoved", `-${stats.removed}`)}` : "",
				].join("")
			: "";
		const target = `${clip(outcome.type, 20)} ${theme.fg("mdCode", clip(outcome.path, 200))}`;
		const head = outcome.ok
			? `${stateMark(theme, "done")} ${target}${counts}`
			: `${stateMark(theme, "failed")} ${target}${theme.fg("error", `: ${clip(outcome.message, 300)}`)}`;
		heads.push(head);
		details.push(head);
		if (outcome.ok && outcome.diff) {
			// A rendered diff has one row per diff line, so the count needs no rendering. Collapsed, several changes show
			// no diff rows and one change shows only its first: colouring the rest would be work nobody sees.
			const source = sanitizeTerminalText(outcome.diff);
			diffLines += source.split("\n").length;
			if (expanded) details.push(...renderDiff(source, { filePath: outcome.path }).split("\n"));
			else if (outcomes.length === 1)
				details.push(...renderDiff(diffHead(source), { filePath: outcome.path }).split("\n"));
		}
	}
	const applied = outcomes.filter((outcome) => outcome.ok).length;
	const summary =
		outcomes.length === 1
			? ""
			: applied === outcomes.length
				? `Applied ${plural(applied, "change")}`
				: `Applied ${applied} of ${plural(outcomes.length, "change")}`;
	if (expanded) return resultBlock(theme, context, { summary, lines: details, error: false, expanded, ...timing });
	if (outcomes.length === 1) {
		// One change: its outcome line, then the first diff lines, like Octocode's edit tool.
		return resultBlock(theme, context, {
			summary: "",
			lines: details,
			totalLines: 1 + diffLines,
			max: DIFF_PREVIEW_LINES + 1,
			error: false,
			expanded,
			...timing,
		});
	}
	const hint =
		diffLines > 0
			? [theme.fg("dim", [`… +${plural(diffLines, "diff line")}`, expandHint()].filter(Boolean).join(" "))]
			: [];
	return resultBlock(theme, context, {
		summary,
		lines: [...heads, ...hint],
		max: heads.length + hint.length,
		error: false,
		expanded,
		...timing,
	});
}
