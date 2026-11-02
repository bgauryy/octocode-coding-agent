import { fileChanges } from "../shared/file-input.ts";
import { Box, type Component, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { BashToolDetails } from "../../core/tools/index.ts";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../theme/theme.ts";
import { formatDuration } from "../shared/format.ts";
import { SHOW_ALL_LINES, resultBlock, resultText, toolHeader } from "../shared/render.ts";
import { contentText } from "../shared/util.ts";
import { clip, expandKey, isInformativeReason, plural } from "../shared/render/text.ts";
import type { RenderContext } from "../shared/render/types.ts";
import { timingOf } from "../shared/render/rows.ts";
import { stateMark } from "../../theme/status.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { VerificationReceipt } from "./bash-jobs/types.ts";
import { parseJobMessage } from "./bash-jobs/message.ts";

/**
 * How the files tools draw: `Bash(cmd)` / `⎿  exit 0 · 12 lines` and the last lines, `File(edit a.ts)` /
 * `✓ edit a.ts +4 -1` with a short diff, and the background job report.
 */
/** What a bash result keeps: Octocode's truncation fields and the background job. */
export interface BashDetails extends BashToolDetails {
	verification?: VerificationReceipt;
	job?: string;
	pid?: number;
	log?: string;
	/** A foreground command that reached its deadline and went on as this job. */
	moved?: boolean;
}

const BASH_STATUS =
	/^Command (?:exited with code (-?\d+)|timed out after (\d+) seconds|aborted|(terminated without an exit code))\.?$/;
const TRUNCATION_NOTICE = /^\[Showing .*Full output: .+\]$/;
/** How the bash tool's hint after a timeout starts; the renderer drops it from the output lines. */
export const RERUN_HINT = "If it needs longer, rerun it";

/** A line Octocode or the bash tool added around the output (status, truncation notice, rerun hint), not command output. */
function noticeLine(trimmed: string): boolean {
	return BASH_STATUS.test(trimmed) || TRUNCATION_NOTICE.test(trimmed) || trimmed.startsWith(RERUN_HINT);
}

const LINE_BREAK = /\r\n?|\n|[\u2028\u2029]/g;

/**
 * Where the last `keep` output lines start: the cut a collapsed preview needs, so a streaming update sanitizes and
 * splits only its tail. Returns 0 when the part before the cut is blank (it would be trimmed, not counted).
 */
function tailCut(text: string, keep: number, structured = false): number {
	let end = text.length;
	let kept = 0;
	while (end > 0 && kept < keep) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		for (const line of sanitizeTerminalText(text.slice(start, end)).split("\n")) {
			const trimmed = line.trim();
			if (trimmed && (structured || !noticeLine(trimmed))) kept += 1;
		}
		end = start === 0 ? 0 : start - 1;
		if (kept >= keep) return /\S/.test(text.slice(0, start)) ? start : 0;
	}
	return 0;
}

/**
 * The `⎿` summary and body of a bash result: `exit 0 · 12 lines`, `exit 1 · 3 lines` (drawn as an error),
 * `timed out after 2m`. Octocode's status and truncation notices move into the summary; the body is the command output.
 * With `keep` (a collapsed preview), the body is only the tail holding the last `keep` output lines and `lines` counts
 * the whole body.
 */
function bashOutcome(
	text: string,
	isError: boolean,
	running = false,
	keep?: number,
	facts?: BashToolDetails,
): { summary: string; body: string; lines?: number; spill?: string } {
	const structured = typeof facts?.output === "string";
	if (structured) text = facts.output!;
	let status =
		facts?.termination === "timeout"
			? `timed out after ${formatDuration((facts.timeoutSeconds ?? 0) * 1000)}`
			: facts?.termination === "aborted"
				? "aborted"
				: facts?.termination === "terminated"
					? "terminated (no exit code)"
					: facts?.exitCode !== undefined && facts.exitCode !== null
						? `exit ${facts.exitCode}`
						: undefined;
	let total = facts?.truncation?.totalLines;
	let spill = facts?.fullOutputPath;
	// An error's message is its first line, so only a status-bearing result is read from its tail.
	const cut = keep !== undefined && (!isError || structured) ? tailCut(text, keep, structured) : 0;
	const head = text.slice(0, cut);
	// Lines before the cut, less the leading blank ones the body trims (`tailCut` keeps a cut only after output).
	const headLines =
		cut === 0 ? 0 : (head.match(LINE_BREAK)?.length ?? 0) - (/^\s*/.exec(head)![0].match(LINE_BREAK)?.length ?? 0);
	const body: string[] = [];
	for (const line of sanitizeTerminalText(cut === 0 ? text : text.slice(cut)).split("\n")) {
		const trimmed = line.trim();
		// Old session entries predate structured Bash facts; parse their host notices only.
		const match = structured ? null : BASH_STATUS.exec(trimmed);
		if (match) {
			status =
				match[1] !== undefined
					? `exit ${match[1]}`
					: match[2] !== undefined
						? `timed out after ${formatDuration(Number(match[2]) * 1000)}`
						: match[3] !== undefined
							? "terminated (no exit code)"
							: "aborted";
			continue;
		}
		if (!structured && TRUNCATION_NOTICE.test(trimmed)) {
			const of = /\bof (\d+)\b/.exec(trimmed);
			if (of) total = Number(of[1]);
			spill = /Full output: (.+?)\]$/.exec(trimmed)?.[1];
			continue;
		}
		if (!structured && trimmed.startsWith(RERUN_HINT)) continue;
		body.push(line);
	}
	while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
	while (cut === 0 && body.length > 0 && body[0].trim() === "") body.shift();
	if (!structured && body.length === 1 && body[0] === "(no output)") body.length = 0;
	if (isError && !status) {
		// Not a command status (a missing directory, a refused command): the message is the summary.
		return { summary: body.shift() ?? "failed", body: body.join("\n"), ...(spill ? { spill } : {}) };
	}
	const lines = headLines + body.length;
	const count = total ?? lines;
	const size = count === 0 ? "no output" : plural(count, "line");
	return {
		summary: running ? `running · ${size}` : `${status ?? "exit 0"} · ${size}`,
		body: body.join("\n"),
		...(cut > 0 ? { lines } : {}),
		...(spill ? { spill } : {}),
	};
}

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
			expanded: options.expanded,
			...(spill ? { spill } : {}),
			...timing,
		}),
		details,
		theme,
	);
}

/** A finished background job: `✓ Job(bash-1: yarn build)`, `↳ <why>`, `⎿  finished after 3s`, its output tail; the status header names its log (format: `bash-jobs/message.ts`). */
export function renderJobMessage(text: string, expanded: boolean, theme: Theme, outputPad = 1): Component {
	const { head, why, log, rest } = parseJobMessage(text);
	const ok = / finished after /.test(head);
	const stopped = !ok && / stopped \(/.test(head); // killed by the user or at shutdown: interrupted, not failed
	// "Background bash bash-1 finished after 3s: yarn build" → `✓ Job(bash-1: yarn build)` / `⎿ finished after 3s`.
	const parts = /^Background bash (\S+) (.+?): (.*)$/.exec(head);
	const context: RenderContext = { isPartial: false, isError: !ok, expanded, state: stopped ? { stopped: true } : {} };
	const box = new Box(outputPad, 0); // custom messages are drawn flush left; pad them like a tool row
	const lines = isInformativeReason(why) ? [theme.fg("toolReason", `↳ ${clip(sanitizeTerminalText(why), 200)}`)] : [];
	box.addChild(toolHeader(theme, context, "Job", parts ? `${parts[1]}: ${parts[3]}` : head, { lines }));
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

export interface QueryOutcome {
	type: "edit" | "write" | "delete";
	path: string;
	reason: string;
	ok: boolean;
	message: string;
	diff?: string;
	/** An applied edit: the change in the file's line count. */
	lineDelta?: number;
	/** A filesystem commit, even if a later step made this query fail. */
	receipt?: MutationReceipt;
}

export interface MutationReceipt {
	canonicalPath: string;
	toolCallId: string;
	operation: "edit" | "write" | "delete";
	digest: string | null;
	/** Digest of bytes this query checked before committing, null for new files. */
	beforeDigest: string | null;
	sessionId: string;
	epoch: string;
	revision: number;
}

/** Diff lines shown per file before expanding. */
const DIFF_PREVIEW_LINES = 6;

/** Size hint for a query in the call line: how many replacements, or how long the new content is. */
export function querySize(query: { type?: string; edits?: unknown[]; content?: string } | undefined): string {
	if (query?.type === "edit" && Array.isArray(query.edits) && query.edits.length > 0)
		return ` · ${plural(query.edits.length, "edit")}`;
	if (query?.type === "write" && typeof query.content === "string") {
		// A final newline ends the last line rather than starting another, as editors and `wc -l` count.
		const content = query.content.endsWith("\n") ? query.content.slice(0, -1) : query.content;
		return ` · ${plural(content === "" ? 0 : content.split("\n").length, "line")}`;
	}
	return "";
}

/** Added and removed line counts of a Octocode diff (lines prefixed with + / -, not the file headers). */
export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (/^\+(?!\+\+ )/.test(line)) added++;
		else if (/^-(?!-- )/.test(line)) removed++;
	}
	return { added, removed };
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
	const why = (query: (typeof queries)[number] | undefined, indent = "", collapsed = false) =>
		(collapsed || context.expanded) && isInformativeReason(query?.reason)
			? [theme.fg("toolReason", `${indent}↳ ${clip(query.reason, 200)}`)]
			: [];
	// One change: File(edit src/a.ts · 2 edits) with the call's reason row under it, or the change's reason (collapsed too) when the call's says nothing. Several: File(3 changes) with a sub-line each.
	if (queries.length <= 1)
		return toolHeader(theme, context, "File", queries.length === 1 ? describe(queries[0]) : "", {
			lines: isInformativeReason(args.reason) ? [] : why(queries[0], "", true),
		});
	const lines = queries.flatMap((query) => [
		`${theme.fg("accent", clip(query?.type ?? "…", 20))} ${theme.fg("mdCode", clip(query?.path ?? "", 200))}${theme.fg("dim", querySize(query))}`,
		...why(query, "  "),
	]);
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
			const diff = renderDiff(sanitizeTerminalText(outcome.diff), { filePath: outcome.path }).split("\n");
			diffLines += diff.length;
			details.push(...diff);
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
			max: DIFF_PREVIEW_LINES + 1,
			error: false,
			expanded,
			...timing,
		});
	}
	const hint =
		diffLines > 0 ? [theme.fg("dim", `… +${plural(diffLines, "diff line")} (${expandKey()} to expand)`)] : [];
	return resultBlock(theme, context, {
		summary,
		lines: [...heads, ...hint],
		max: heads.length + hint.length,
		error: false,
		expanded,
		...timing,
	});
}
