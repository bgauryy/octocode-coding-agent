import { Box, type Component, Container } from "@octocodeai/octocode-tui";
import type {
	AgentToolResult,
	ExtensionAPI,
	MessageRenderer,
	ToolRenderResultOptions,
} from "../../core/extensions/index.ts";
import type { Theme } from "../../theme/theme.ts";
import { archiveSearch, LIBRARY_FILE } from "../shared/archive.ts";
import { fencedParts } from "../shared/fence.ts";
import { trustNoticeShown } from "../shared/trust.ts";
import { presentAgentReport } from "./presentation.ts";
import {
	formatCost,
	formatDuration,
	formatTokens,
	formatTokenUsage,
	shortPath,
	toolCallCount,
} from "../shared/format.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { addReply, contentText, emptyTotals } from "../shared/util.ts";
import { noticeText } from "./events.ts";
import { shareRowState, sharedRowState } from "../shared/row-mark.ts";
import { agentState, headerOverride } from "./render-state.ts";

/**
 * How the `agent` tool and a background subagent's report message are drawn: `● Agent(goal · model) · 38s`, then live
 * progress while it runs and `⎿ Done (name · 4 tool calls · ↑12k (80% cached) ↓2k · ≈$0.12 · 38s)` with the answer once it finishes. The row
 * stays one short line; the full prompt the agent was given shows in the expanded view, above its progress or report.
 */

import type { RunDetails, ResultDetails } from "./run-types.ts";
import { bodyLines, clip, plural } from "../shared/render/text.ts";
import type { RenderContext } from "../shared/render/types.ts";
import { ReportView } from "../shared/render/report.ts";
import { displayReport } from "./report-display.ts";
import { timingOf } from "../shared/render/rows.ts";
import { isRecord } from "../../utils/guards.ts";
import { AGENT_RESULT_TYPE } from "../shared/messages.ts";

/** The model a run is on without its provider (`claude-haiku-5-5:low`), marked as the parent's when the profile's preference was unavailable. */
function modelLabel(details: Pick<RunDetails, "model" | "fallback">): string {
	const model = details.model?.slice(details.model.lastIndexOf("/") + 1);
	return details.fallback ? `${model ?? "parent model"} (${details.fallback} unavailable)` : (model ?? "");
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
 * The untrusted-project warning (`shared/trust.ts`). A subagent inherits its parent's trust decision, so when this session
 * showed the same warning the report need not repeat it; a child that alone lacks config (an isolated worktree whose
 * files differ) keeps it.
 */
const TRUST_NOTICE = /^Project config not loaded \(\d+ files?\)\./;

/**
 * What the child's extensions said that a person would have read on screen (warnings, errors, the latest compaction
 * failure), one line each and whole, identical repeats folded with a count. Notices past the inline page end in one line
 * naming the file that holds every notice. Text of the child: callers place it with the child's own words, never among
 * the parent's.
 */
export function noticeLines(
	details: Pick<RunDetails, "compactions" | "notices">,
	shown: boolean = trustNoticeShown(),
): string[] {
	const { more = 0, file } = details.notices ?? {};
	const kept = (details.notices?.kept ?? []).filter((notice) => !(shown && TRUST_NOTICE.test(notice.text)));
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

/** `inky-kraken · 4 tool calls · ↑12k (80% cached) ↓2k · ≈$0.12 · model` while a run works (no tool calls yet: none named). */
function runStats(details: Progress): string {
	return [
		details.id,
		details.toolCalls > 0 ? toolCallCount(details.toolCalls) : "",
		deniedLabel(details),
		compactionLabel(details),
		formatTokenUsage(details),
		formatCost(details),
		modelLabel(details),
	]
		.filter(Boolean)
		.join(" · ");
}

/** What the expanded summary adds to a finished run's row: compactions, tokens, cost and model. */
function finishedStats(
	totals: Parameters<typeof formatTokenUsage>[0] & Parameters<typeof formatCost>[0],
	details: Pick<RunDetails, "model" | "fallback" | "compactions">,
): string {
	return [compactionLabel(details), formatTokenUsage(totals), formatCost(totals), modelLabel(details)]
		.filter(Boolean)
		.join(" · ");
}

/** A background report's usage as run totals (what `RunDetails` carries directly). */
function usageTotals(details: Partial<ResultDetails>) {
	const totals = emptyTotals();
	addReply(totals, details.usage, details.unpriced === true);
	return totals;
}

export const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * `Done · 4 tool calls · 38s`; `Blocked · …` when the report says so. `named` adds the agent id after the outcome for a
 * row whose header does not carry it. Tokens, cost and model go to the expanded view (`finishedStats`).
 */
export function doneSummary(
	details: Pick<RunDetails, "id" | "toolCalls" | "denied" | "outcome">,
	durationMs: number | undefined,
	named = false,
): string {
	return [
		details.outcome ? capitalize(details.outcome) : "Done",
		named ? details.id : "",
		details.toolCalls > 0 ? toolCallCount(details.toolCalls) : "",
		deniedLabel(details),
		durationMs === undefined ? "" : formatDuration(durationMs, true),
	]
		.filter(Boolean)
		.join(" · ");
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

/** A launch under a second is routine: the row's clock would only be mistaken for the run's. */
const LAUNCH_SHOWN_MS = 1_000;

export function renderAgentCall(args: AgentArgs, theme: Theme, context: RenderContext): Component {
	// The result's renderer says when the run needs the user (`◇`) or its report is a failure (`✗`).
	const state = sharedRowState(context);
	const mark = state ? { state } : {};
	if (!args.background) return toolHeader(theme, context, "Agent", runLabel(args), mark);
	const quick = context.durationMs !== undefined && context.durationMs < LAUNCH_SHOWN_MS;
	return toolHeader(theme, quick ? { ...context, durationMs: undefined } : context, "Agent", runLabel(args), {
		meta: "background",
		...mark,
	});
}

export function renderAgentResult(
	result: AgentToolResult<unknown>,
	{ isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	const details = result.details as RunDetails | undefined;
	const raw = contentText(result.content);
	const fenced = fencedParts(raw);
	const body = fenced ? [fenced.body, fenced.footer].filter(Boolean).join("\n\n") : raw;
	const task = argsOf(context).task;
	if (context.isError || !details) {
		const [head = "", ...rest] = raw.split("\n");
		const more = fenced ? body : rest.join("\n");
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
	shareRowState(context, headerOverride(agentState(details)));
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
		summary: doneSummary(details, context.durationMs, true),
		stats: finishedStats(details, details),
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
	options: { summary: string; stats?: string; report: string; preface: string[]; stopped?: boolean },
): Component {
	const expanded = context.expanded === true;
	// The summary row already names the outcome: the report drawn under it leads with its content.
	const shown = displayReport(options.report, expanded);
	const hasReport = shown.text.trim() !== "" || shown.earlier > 0;
	const container = new Container();
	// The summary row stays as it is: the prompt hint goes after the report, so a long summary is never clipped for it.
	container.addChild(
		resultBlock(theme, context, {
			summary: expanded && options.stats ? `${options.summary} · ${options.stats}` : options.summary,
			lines: [],
			// With a report, the prompt hint follows the report; without one it is the row's own hint line.
			...(hasReport && !expanded ? { max: 0 } : { prefaceLabel: "prompt", preface: options.preface }),
			...(options.stopped !== undefined ? { stopped: options.stopped } : {}),
		}),
	);
	if (hasReport)
		container.addChild(
			new ReportView(theme, shown.text, expanded, options.preface.length > 0 ? "prompt" : undefined, shown.earlier),
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
			{
				meta: "background",
				state: agentState(details),
				...(details.durationMs === undefined ? {} : { durationMs: details.durationMs }),
			},
		),
	);
	box.addChild(
		reportBlock(theme, context, {
			summary: presentation.summary,
			stats: finishedStats(usageTotals(details), details),
			report,
			stopped,
			preface: promptPreface(theme, details.task, report.trim() ? "Report" : undefined),
		}),
	);
	return box;
};

/** Draws background subagent reports (`AGENT_RESULT_TYPE` custom messages) in the transcript. */
export function registerAgentMessageRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
	pi.registerMessageRenderer(AGENT_RESULT_TYPE, renderAgentMessage);
}
