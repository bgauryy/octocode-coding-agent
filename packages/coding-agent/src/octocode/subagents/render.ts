import { Box, type Component, Container } from "@octocodeai/octocode-tui";
import type { AgentToolResult, MessageRenderer, ToolRenderResultOptions } from "../../core/extensions/index.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { archiveSearch, LIBRARY_FILE } from "../shared/archive.ts";
import { presentAgentReport } from "./presentation.ts";
import {
	formatCost,
	formatDuration,
	formatTokens,
	formatTokenUsage,
	shortPath,
	toolCallCount,
} from "../shared/format.ts";
import {
	bodyLines,
	clip,
	plural,
	type RenderContext,
	ReportView,
	resultBlock,
	timingOf,
	toolHeader,
} from "../shared/render.ts";
import { contentText, isRecord } from "../shared/util.ts";
import { noticeText } from "./events.ts";

/**
 * How the `agent` tool and a background subagent's report message are drawn: `● Agent(goal · model) · 38s`, then live
 * progress while it runs and `⎿ Done (name · 4 tool calls · ↑12k (80% cached) ↓2k · ≈$0.12 · 38s)` with the answer once it finishes. The row
 * stays one short line; the full prompt the agent was given shows in the expanded view, above its progress or report.
 */

export type { RunDetails, ResultDetails } from "./run-types.ts";
import type { RunDetails, ResultDetails } from "./run-types.ts";

/** The model a run is on: its `provider/id`, marked as the parent's when the profile's preference was unavailable. */
function modelLabel(details: Pick<RunDetails, "model" | "fallback">): string {
	if (!details.fallback) return details.model ?? "";
	return `${details.model ?? "parent model"} (${details.fallback} unavailable)`;
}

/** `2 denied`: tool calls the child had no one to approve (empty when none). */
export const deniedLabel = (details: Pick<RunDetails, "denied">): string =>
	details.denied ? `${details.denied} denied` : "";

/** `2 compactions (1 failed)`: how often the child compacted its context (empty when it never did). */
export function compactionLabel(details: Pick<RunDetails, "compactions">): string {
	const { done = 0, aborted = 0, failed = 0 } = details.compactions ?? {};
	const bad = [failed ? `${failed} failed` : "", aborted ? `${aborted} aborted` : ""].filter(Boolean).join(", ");
	return done + aborted + failed === 0
		? ""
		: `${plural(done + aborted + failed, "compaction")}${bad ? ` (${bad})` : ""}`;
}

/** The child's compactions as a line of the parent's own report: `Compactions: 2 done, 1 failed; latest 150k → 32k tokens.` (the failure's text is in `noticeLines`). */
export function compactionNote(details: Pick<RunDetails, "compactions">): string {
	const { done = 0, aborted = 0, failed = 0, tokensBefore, tokensAfter } = details.compactions ?? {};
	if (done + aborted + failed === 0) return "";
	const counts = [done ? `${done} done` : "", aborted ? `${aborted} aborted` : "", failed ? `${failed} failed` : ""]
		.filter(Boolean)
		.join(", ");
	const size =
		tokensBefore !== undefined && tokensAfter !== undefined
			? `; latest ${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)} tokens`
			: "";
	return `Compactions: ${counts}${size}.`;
}

/**
 * What the child's extensions said that a person would have read on screen (warnings, errors, the latest compaction
 * failure), one line each and whole, identical repeats folded with a count. Notices past the inline page end in one line
 * naming the file that holds every notice. Text of the child: callers place it with the child's own words, never among
 * the parent's.
 */
export function noticeLines(details: Pick<RunDetails, "compactions" | "notices">): string[] {
	const { kept = [], more = 0, file } = details.notices ?? {};
	const failure = details.compactions?.error;
	const rest = file
		? `+${more} more notices; every notice, whole, is in ${shortPath(file)} (read it, or search it)`
		: `+${more} more notices, not saved`;
	const lines = [
		...kept.map(noticeText),
		...(more > 0 ? [rest] : []),
		...(failure ? [`latest compaction failure: ${failure}`] : []),
	];
	return lines.length > 0 ? ["Notices from the subagent (it has no screen):", ...lines.map((line) => `- ${line}`)] : [];
}

/** Where the child's archive of compacted history is, for the parent's report (empty when it never compacted). */
export function archiveNote(details: Pick<RunDetails, "session">): string {
	const archive = details.session?.archive;
	return archive
		? `Its compacted history is archived in ${archive} (${LIBRARY_FILE} indexes it). ${archiveSearch()}`
		: "";
}

/** `Session inky-kraken: <file>`: where the child's conversation is saved (the id alone until its file exists). */
export function sessionNote(details: Pick<RunDetails, "session">): string {
	const { session } = details;
	return session ? `Session ${session.id}${session.file ? `: ${shortPath(session.file)}` : ""}` : "";
}

type Progress = Pick<
	RunDetails,
	| "id"
	| "toolCalls"
	| "denied"
	| "input"
	| "cacheRead"
	| "output"
	| "cost"
	| "unpriced"
	| "model"
	| "fallback"
	| "compactions"
>;

/** `inky-kraken · 4 tool calls · ↑12k (80% cached) ↓2k · ≈$0.12`, then `extra` (a duration), then the model. */
function runStats(details: Progress, ...extra: string[]): string {
	return [
		details.id,
		toolCallCount(details.toolCalls),
		deniedLabel(details),
		compactionLabel(details),
		formatTokenUsage(details),
		formatCost(details),
		...extra,
		modelLabel(details),
	]
		.filter(Boolean)
		.join(" · ");
}

export const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** `Done (inky-kraken · 4 tool calls · ↑12k (80% cached) ↓2k · ≈$0.12 · 38s · provider/id)`; `Blocked (…)` when the report says so. */
export function doneSummary(details: Progress & Pick<RunDetails, "outcome">, durationMs: number | undefined): string {
	const label = details.outcome ? capitalize(details.outcome) : "Done";
	return `${label} (${runStats(details, durationMs === undefined ? "" : formatDuration(durationMs, true))})`;
}

interface AgentArgs {
	task?: string | undefined;
	goal?: string | undefined;
	/** Not drawn: the row names the run by its goal; `/agents` and `coordinate list` show the role. */
	profile?: string | undefined;
	model?: string | undefined;
	background?: boolean | undefined;
	isolate?: boolean | undefined;
}

const argsOf = (context: RenderContext): AgentArgs => (isRecord(context.args) ? context.args : {});

/**
 * `Prompt` and the task, then the heading of what follows (`Report`, `Progress`): the expanded view's preface. Task
 * text comes from the model and may carry escape sequences; it is sanitized here.
 */
function promptPreface(theme: Theme, task: string | undefined, next: string | undefined): string[] {
	const rows = bodyLines(task ?? "");
	if (rows.length === 0) return [];
	const heading = (text: string) => theme.fg("accent", theme.bold(text));
	return [heading("Prompt"), ...rows.map((row) => theme.fg("muted", row)), ...(next ? ["", heading(next)] : [])];
}

/** Characters of the goal a row shows. */
const GOAL_ROW_CHARS = 60;

/** `audit auth token refresh · gpt-5 · isolated`: what the row says about the run, never the prompt or the profile. */
function runLabel(args: AgentArgs): string {
	return [
		args.goal ? clip(args.goal, GOAL_ROW_CHARS) : "",
		args.model ? clip(args.model, 40) : "",
		args.isolate ? "isolated" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

export function renderAgentCall(args: AgentArgs, theme: Theme, context: RenderContext): Component {
	return toolHeader(theme, context, "Agent", runLabel(args), args.background ? { meta: "background" } : {});
}

export function renderAgentResult(
	result: AgentToolResult<unknown>,
	{ isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	const details = result.details as RunDetails | undefined;
	const body = contentText(result.content);
	const task = argsOf(context).task;
	if (context.isError || !details) {
		const [head = "", ...rest] = body.split("\n");
		const more = rest.join("\n");
		return resultBlock(theme, context, {
			summary: head,
			body: more,
			prefaceLabel: "prompt",
			preface: promptPreface(theme, task, more.trim() ? "Output" : undefined),
			...timingOf(result.details),
		});
	}
	// Waiting for a slot: the row says how many run before it.
	if (isPartial && details.status === "waiting")
		return resultBlock(theme, context, {
			summary: body,
			summaryColor: "muted",
			lines: [],
			max: 0,
			prefaceLabel: "prompt",
			preface: promptPreface(theme, task, undefined),
		});
	if (isPartial) {
		// Live progress: counts, then the latest steps (the header carries the running clock).
		const lines = [
			...details.activity.slice(-3).map((line) => theme.fg("dim", clip(line, 200))),
			...(details.thinking ? [theme.italic(theme.fg("thinkingText", `✻ ${clip(details.thinking, 200)}…`))] : []),
			...(details.shot ? [theme.fg("dim", `📷 ${clip(shortPath(details.shot), 200)}`)] : []),
		];
		const summary = details.stopping
			? `stopping… (${runStats(details)})`
			: details.waiting
				? `waiting for your approval (${runStats(details)})`
				: details.compacting
					? `compacting its context (${runStats(details)})`
					: runStats(details);
		return resultBlock(theme, context, {
			summary,
			summaryColor: details.stopping || details.waiting ? "warning" : details.compacting ? "accent" : "toolOutput",
			lines,
			max: lines.length,
			prefaceLabel: "prompt",
			preface: promptPreface(theme, task, lines.length > 0 ? "Progress" : undefined),
		});
	}
	if (details.status === "background") {
		// The first line is for the model; only a later note (an isolation warning) is worth expanding to.
		const note = body.split("\n").slice(1).join("\n").trim();
		return resultBlock(theme, context, {
			summary: `Running in the background as ${details.id}`,
			summaryColor: "accent",
			...(note ? { body: note } : {}),
			prefaceLabel: "prompt",
			preface: promptPreface(theme, task, note ? "Note" : undefined),
			max: 0,
			...timingOf(result.details),
		});
	}
	return reportBlock(theme, context, {
		summary: doneSummary(details, context.durationMs),
		report: body,
		preface: promptPreface(theme, task, body.trim() ? "Report" : undefined),
		...timingOf(result.details),
	});
}

/**
 * A finished subagent: its result row (the prompt one expand away), then the report rendered as Markdown and shown
 * whole unless it is long. Foreground results and background report messages share it.
 */
function reportBlock(
	theme: Theme,
	context: RenderContext,
	options: { summary: string; report: string; preface: string[]; stopped?: boolean },
): Component {
	const expanded = context.expanded === true;
	const hasReport = options.report.trim() !== "";
	const container = new Container();
	// The summary row stays as it is: the prompt hint goes after the report, so a long summary is never clipped for it.
	container.addChild(
		resultBlock(theme, context, {
			summary: options.summary,
			lines: [],
			// With a report, the prompt hint follows the report; without one it is the row's own hint line.
			...(hasReport && !expanded ? { max: 0 } : { prefaceLabel: "prompt", preface: options.preface }),
			...(options.stopped !== undefined ? { stopped: options.stopped } : {}),
		}),
	);
	if (hasReport)
		container.addChild(
			new ReportView(theme, options.report, expanded, options.preface.length > 0 ? "prompt" : undefined),
		);
	return container;
}

/**
 * A background subagent's report, drawn like the tool row it came from: `● Agent(id)` then `⎿ Done (…)` and
 * the report; expanded, the full prompt comes first.
 */
export const renderAgentMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	const details = (message.details ?? {}) as Partial<ResultDetails>;
	const presentation = presentAgentReport(message.content, details);
	const report = presentation.body;
	const stopped = details.status === "stopped";
	// A stop (asked for or not) is an interruption, not a failure: drawn `◼` in the warning colour.
	const context = {
		isPartial: false,
		isError: details.status === "failed" || stopped,
		expanded,
		state: stopped ? { stopped: true } : {},
	};
	// Octocode draws custom messages flush left; pad them like a tool row.
	const box = new Box(outputPad ?? 1, 0);
	box.addChild(
		toolHeader(
			theme,
			context,
			"Agent",
			[details.id ?? "background", details.goal && clip(details.goal, GOAL_ROW_CHARS)].filter(Boolean).join(" · "),
			details.durationMs === undefined
				? { meta: "background" }
				: { meta: "background", durationMs: details.durationMs },
		),
	);
	box.addChild(
		reportBlock(theme, context, {
			summary: presentation.summary,
			report,
			stopped,
			preface: promptPreface(theme, details.task, report.trim() ? "Report" : undefined),
		}),
	);
	return box;
};
