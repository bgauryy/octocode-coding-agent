import { fileChanges } from "../shared/file-input.ts";
import { Box, type Component, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../theme/theme.ts";
import { SHOW_ALL_LINES, resultBlock, resultText, toolHeader } from "../shared/render.ts";
import { contentText } from "../shared/util.ts";
import { clip, expandKey, plural } from "../shared/render/text.ts";
import { isInformativeReason } from "../shared/reason.ts";
import type { RenderContext } from "../shared/render/types.ts";
import { timingOf } from "../shared/render/rows.ts";
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

/** Diff lines shown per file before expanding. */
const DIFF_PREVIEW_LINES = 6;

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
