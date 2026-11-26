import { fileChanges } from "../tool-input/file-input.ts";
import { Box, type Component, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { renderDiff } from "../../theme/diff.ts";
import type { Theme } from "../../theme/theme.ts";
import { resultBlock, resultText, SHOW_ALL_LINES, toolHeader } from "../render/tool.ts";
import { contentText } from "../shared/util.ts";
import { clip, expandHint, linkPath, plural } from "../shared/text.ts";
import { isInformativeReason } from "../shared/reason.ts";
import type { RenderContext } from "../render/types.ts";
import { timingOf } from "../render/rows.ts";
import { formatDuration } from "../shared/format.ts";
import { stateMark } from "../../theme/status.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { parseJobMessage, readJobEnd } from "./bash-jobs/message.ts";
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

/** The arguments of a shell call the header reads. */
interface ShellCallArgs {
	type?: string;
	command?: unknown;
	timeout?: unknown;
	background?: unknown;
}

/** `Bash(cmd) · background · timeout 2m`: the one shell header, for the native tool and the core one alike. */
export function renderBashCall(args: ShellCallArgs | undefined, theme: Theme, context: RenderContext): Component {
	// The timeout shows only when the model set one; the default deadline is in the tool description.
	const asked = typeof args?.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
	const timeout = asked ? `timeout ${formatDuration(asked * 1000)}` : "";
	const meta = [args?.background === true ? "background" : "", timeout].filter(Boolean).join(" · ");
	return toolHeader(
		theme,
		context,
		args?.type === "powershell" ? "PowerShell" : "Bash",
		typeof args?.command === "string" ? args.command : "",
		meta ? { meta } : {},
	);
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

/**
 * A finished background job: `✓ Bash(bash-1: yarn build) · background`, `↳ <why>`, `⎿  finished after 3s`, its output tail;
 * the status header names its log. The row reads the job's `details` (`bash-jobs/message.ts`); text alone draws the
 * report's first line as a failure.
 */
export function renderJobMessage(
	text: string,
	expanded: boolean,
	theme: Theme,
	outputPad = 1,
	details?: unknown,
): Component {
	const parsed = parseJobMessage(text);
	const end = readJobEnd(details);
	const facts = isRecord(details) ? details : {};
	const head = parsed.head;
	const ok = end?.ok ?? false;
	// Killed by the user or at shutdown: interrupted, not failed.
	const stopped = end?.interrupted === true;
	const id = typeof facts.id === "string" ? facts.id : undefined;
	const command = typeof facts.command === "string" ? facts.command : undefined;
	const why = end?.why;
	const log = typeof facts.log === "string" ? facts.log : parsed.log;
	const summary = end ? `${end.how} after ${formatDuration(end.seconds * 1000)}` : head;
	const context: RenderContext = { isPartial: false, isError: !ok, expanded, state: stopped ? { stopped: true } : {} };
	const box = new Box(outputPad, 0); // custom messages are drawn flush left; pad them like a tool row
	const lines = isInformativeReason(why) ? [theme.fg("toolReason", `↳ ${clip(sanitizeTerminalText(why), 200)}`)] : [];
	box.addChild(
		toolHeader(theme, context, "Bash", id && command !== undefined ? `${id}: ${command}` : head, {
			lines,
			meta: "background",
		}),
	);
	box.addChild(
		resultBlock(theme, context, {
			summary,
			body: parsed.rest.join("\n"),
			tail: true,
			error: !ok,
			stopped,
			...(log ? { spill: log, spillLabel: "log" } : {}),
		}),
	);
	return box;
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

/** `path` as shown in a row (clipped), linked to the file where the terminal supports it. */
function shownPath(theme: Theme, path: string, cwd?: string): string {
	return theme.fg("mdCode", linkPath(clip(path, 200), path, cwd));
}

export function renderFileCall(args: FileArgs, theme: Theme, context: RenderContext): Component {
	const queries = fileChanges(args) as NonNullable<typeof args.queries>;
	// One change: `File(edit src/a.ts) · 2 edits`, the path linked. Several: `File(3 changes)` with a sub-line each.
	// Reasons are drawn once, by `reasonRow`.
	if (queries.length === 1) {
		const [query] = queries;
		const target = `${query?.path ?? ""}${query?.movePath ? ` → ${query.movePath}` : ""}`;
		const size = querySize(query).replace(/^ · /, "");
		return toolHeader(theme, context, "File", clip(`${query?.type ?? "…"} ${target}`, 200), {
			...(size ? { meta: size } : {}),
			...(query?.path ? { link: query.path } : {}),
		});
	}
	if (queries.length === 0) return toolHeader(theme, context, "File", "");
	const lines = queries.map(
		(query) =>
			`${theme.fg("accent", clip(query?.type ?? "…", 20))} ${shownPath(theme, query?.path ?? "", context.cwd)}${theme.fg("dim", querySize(query))}`,
	);
	return toolHeader(theme, context, "File", `${queries.length} changes`, { lines });
}

/** `+4 -1`, coloured; empty without a diff. */
function diffCounts(theme: Theme, diff: string | undefined): { plain: string; styled: string } {
	if (!diff) return { plain: "", styled: "" };
	const { added, removed } = diffStats(diff);
	const parts = [
		added > 0 || removed === 0 ? (["toolDiffAdded", `+${added}`] as const) : undefined,
		removed > 0 ? (["toolDiffRemoved", `-${removed}`] as const) : undefined,
	].filter((part) => part !== undefined);
	return {
		plain: parts.map(([, text]) => text).join(" "),
		styled: parts.map(([color, text]) => theme.fg(color, text)).join(" "),
	};
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
	if (outcomes.length === 1) {
		// One change: collapsed shows only the file diff counts (`+4 -1 · ctrl+o to expand`), skipping `renderDiff` until clicked/expanded.
		const [outcome] = outcomes;
		if (!outcome.ok)
			return resultBlock(theme, context, { summary: clip(outcome.message, 300), error: true, expanded, ...timing });
		const counts = diffCounts(theme, outcome.diff);
		const source = outcome.diff ? sanitizeTerminalText(outcome.diff) : "";
		const lines = expanded && source ? renderDiff(source, { filePath: outcome.path }).split("\n") : [];
		return resultBlock(theme, context, {
			summary: counts.plain || outcome.message || outcome.type,
			...(counts.styled ? { styledSummary: counts.styled } : {}),
			lines,
			totalLines: source ? source.split("\n").length : 0,
			max: 0,
			error: false,
			expanded,
			...timing,
		});
	}
	// Several changes: a line per file (`edit src/a.ts +4 -1`, `✗` and the reason for one that failed), the diffs only when expanded.
	const rows: string[] = [];
	let diffLines = 0;
	for (const outcome of outcomes) {
		const target = `${clip(outcome.type, 20)} ${shownPath(theme, outcome.path, context.cwd)}`;
		const counts = diffCounts(theme, outcome.ok ? outcome.diff : undefined).styled;
		rows.push(
			outcome.ok
				? `${target}${counts ? ` ${counts}` : ""}`
				: `${stateMark(theme, "failed")} ${target}${theme.fg("error", `: ${clip(outcome.message, 300)}`)}`,
		);
		if (outcome.ok && outcome.diff) {
			// A rendered diff has one row per diff line, so the count needs no rendering: collapsed, no diff is coloured.
			const source = sanitizeTerminalText(outcome.diff);
			diffLines += source.split("\n").length;
			if (expanded) rows.push(...renderDiff(source, { filePath: outcome.path }).split("\n"));
		}
	}
	const applied = outcomes.filter((outcome) => outcome.ok).length;
	const summary =
		applied === outcomes.length
			? `Applied ${plural(applied, "change")}`
			: `Applied ${applied} of ${plural(outcomes.length, "change")}`;
	if (expanded) return resultBlock(theme, context, { summary, lines: rows, error: false, expanded, ...timing });
	const hint =
		diffLines > 0
			? [theme.fg("dim", [`… +${plural(diffLines, "diff line")}`, expandHint()].filter(Boolean).join(" "))]
			: [];
	return resultBlock(theme, context, {
		summary,
		lines: [...rows, ...hint],
		max: rows.length + hint.length,
		error: false,
		expanded,
		...timing,
	});
}
