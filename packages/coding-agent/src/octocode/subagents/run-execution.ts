import type { ReportStatus } from "../instructions/report.ts";
import { errorMessage } from "../../utils/guards.ts";
import { formatCost, formatDuration, shortPath, toolCallCount } from "../shared/format.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { firstLine } from "../shared/util.ts";
import type { AgentRuns, Run } from "./claim.ts";
import type { BackgroundRun } from "./command.ts";
import { withStopFacts } from "./budget.ts";
import { pendingReportsDir, type Report, savePendingReport } from "./handoff/pending.ts";
import type { runSubagent } from "./process.ts";
import { USER_STOP } from "./process/outcome.ts";
import { capitalize, compactionLabel, deniedLabel, doneSummary, noticeLines } from "./render.ts";
import { failedNext, foregroundExtras, PERMISSION_STOP, reportMessage, stoppedError } from "./report-text.ts";
import { unavailableResult } from "./result-schema.ts";
import type { RunDetails } from "./run-types.ts";
import { stopFacts } from "./stop-facts.ts";
import { reportFacts, runFooter, withShot } from "./tracking.ts";

type Outcome = Awaited<ReturnType<typeof runSubagent>>;

/** Runs the subagent in the background; its report (or why it stopped) arrives as a message, and then it gives its slot back. */
export function startBackground(
	runs: AgentRuns,
	run: Run,
	details: RunDetails,
	task: string,
	launch: (signal: AbortSignal) => Promise<Outcome>,
	finish: () => Promise<string>,
	piSession: string,
	linger?: (outcome?: ReportStatus, awaitsReply?: boolean) => string,
): void {
	const { background, read } = runs;
	const { identity } = run;
	const session = runs.session;
	// A report that arrives after its session ended (a reload, a switch) is kept for the next start of that Octocode session.
	const reports = {
		add: (report: Report) =>
			session === runs.session
				? runs.reports.add(report)
				: savePendingReport(pendingReportsDir(piSession), identity.id, report),
	};
	const controller = new AbortController();
	const entry: BackgroundRun = { controller, done: Promise.resolve() };
	background.set(identity.id, entry);
	runs.changed();
	read.track(identity.id, identity.scratch);
	// The parent may have many runs going: every report names the agent, its role and its goal.
	const who = `${identity.id} (${identity.role}: ${identity.goal})`;
	// For the renderer: the expanded report shows the whole prompt.
	const shown = { task, goal: identity.goal ?? "", profile: identity.role ?? "" };
	entry.done = (async () => {
		try {
			const outcome = withStopFacts(await launch(controller.signal), details, runs.team);
			const note = await finish();
			// The latest report determines the outcome; a failed follow-up overrides earlier success.
			const reported = outcome.error ? "failed" : outcome.outcome;
			if (reported) details.outcome = reported;
			const source = outcome.error ? undefined : outcome.outcomeSource;
			if (source) details.outcomeSource = source;
			if (outcome.structured) details.structured = outcome.structured;
			const typedFailure = identity.resultContract && (reported !== "done" || outcome.structured?.status !== "valid");
			const stats = [
				formatDuration(Date.now() - details.startedAt),
				toolCallCount(details.toolCalls),
				deniedLabel(details),
				compactionLabel(details),
				formatCost(details),
			]
				.filter(Boolean)
				.join(" · ");
			const head = outcome.error
				? `Background subagent ${who} failed`
				: `Background subagent ${who} ${reported ? `reported ${reported}` : "finished"} (${stats})`;
			const durationMs = Date.now() - details.startedAt;
			const summary = outcome.error ? `Failed: ${firstLine(outcome.error)}` : doneSummary(details, durationMs);
			const alreadyRead = read.consume(identity.id);
			const next = outcome.error ? failedNext(run.route, outcome.error, Boolean(outcome.text)) : "";
			const notices = noticeLines(details).join("\n");
			// A successful run that lingers stays reachable: the report says for how long and how to use or end it. One with an unanswered ask to its parent lingers whatever it reported.
			const reachable = outcome.error
				? ""
				: (linger?.(reported, details.asks?.some((ask) => !ask.answer) === true) ?? "");
			// The child's own notices sit with its words, inside the fence: only the parent's counts ride in the footer.
			const text = [outcome.text || "(no text)", notices].filter(Boolean).join("\n\n");
			const body = outcome.error ? `Error: ${outcome.error}\n${text}` : text;
			const shot = details.shot ? `(Last screenshot: ${shortPath(details.shot)})` : "";
			reports.add({
				content: reportMessage(head, body, [
					...(typedFailure ? [`Result schema validation: ${outcome.structured?.error?.code ?? "unavailable"}.`] : []),
					next,
					...runFooter(details, Boolean(outcome.error)),
					shot,
					note,
					reachable,
				]),
				details: {
					id: identity.id,
					status: outcome.error ? "failed" : "done",
					...(reported ? { outcome: reported } : {}),
					...(source ? { outcomeSource: source } : {}),
					summary,
					durationMs,
					...shown,
					...reportFacts(details),
				},
				wake: !alreadyRead,
			});
		} catch (error) {
			if (identity.resultContract) details.structured = unavailableResult(identity.resultContract);
			const note = await finish();
			read.consume(identity.id);
			const by = entry.stoppedBy;
			const reason =
				by === USER_SENDER ? "cancelled by the user" : by ? `stopped by ${by}` : `stopped: ${errorMessage(error)}`;
			const reachable = by === PERMISSION_STOP ? (linger?.() ?? "") : "";
			reports.add({
				// A stop someone asked for is the parent's own word; any other cause (a crash, a stall) quotes the child's output.
				content: by
					? `Background subagent ${who} ${reason}${by === PERMISSION_STOP ? stopFacts(details, runs.team) : ""}${note}${reachable}`
					: reportMessage(
							`Background subagent ${who} stopped`,
							[errorMessage(error), ...noticeLines(details)].join("\n\n"),
							[...runFooter(details, true), note, reachable],
						),
				details: {
					id: identity.id,
					status: "stopped",
					...(by ? { requested: true } : { outcome: "failed" as const }),
					summary: capitalize(reason),
					durationMs: Date.now() - details.startedAt,
					...shown,
					...reportFacts(details),
				},
				wake: !by,
			});
		} finally {
			background.delete(identity.id);
			runs.changed();
		}
	})().catch((error: unknown) => {
		// Something in the report path itself threw: the parent still learns that the run is over, and `done` never rejects.
		try {
			reports.add({
				content: `Background subagent ${who} ended, but its report could not be built: ${errorMessage(error)}`,
				details: {
					id: identity.id,
					status: "failed",
					...(details.runId ? { runId: details.runId } : {}),
					startedAt: details.startedAt,
					outcome: "failed",
					summary: `Failed: ${firstLine(errorMessage(error))}`,
					durationMs: Date.now() - details.startedAt,
					...shown,
				},
				wake: true,
			});
		} catch {
			// The session is gone; the child's scratch folder still holds what it wrote.
		}
	});
}

/**
 * Runs the subagent and waits for its report; the child's model usage counts toward this session's totals. `stopping`
 * redraws the row the moment a stop begins: the child, and an isolated run's worktree, still take a moment to close.
 */
export async function runForeground(
	runs: AgentRuns,
	run: Run,
	details: RunDetails,
	launch: (signal: AbortSignal) => Promise<Outcome>,
	finish: () => Promise<string>,
	warning: string,
	signal: AbortSignal | undefined,
	stopping: () => void,
) {
	const { identity } = run;
	// Its own controller, so `/agents kill` can stop this run without aborting the parent's turn. Esc is the user's stop.
	const controller = new AbortController();
	const entry: BackgroundRun = { controller, done: Promise.resolve() };
	const abort = () => controller.abort(USER_STOP);
	controller.signal.addEventListener("abort", stopping, { once: true });
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });
	runs.foreground.set(identity.id, entry);
	let outcome: Outcome;
	try {
		outcome = withStopFacts(await launch(controller.signal), details, runs.team);
	} catch (error) {
		const note = `${entry.stoppedBy === PERMISSION_STOP ? stopFacts(details, runs.team) : ""}${await finish()}${entry.stoppedBy ? "" : foregroundExtras(details, true)}`;
		const reason = entry.stoppedBy ? stoppedError(identity.id, entry.stoppedBy) : error;
		throw note ? new Error(`${errorMessage(reason)}${note}`) : reason;
	} finally {
		signal?.removeEventListener("abort", abort);
		runs.foreground.delete(identity.id);
	}
	const note = `${await finish()}${warning}${foregroundExtras(details, Boolean(outcome.error))}`;
	if (outcome.structured) details.structured = outcome.structured;
	if (outcome.error) {
		// An error result rather than a throw, so the child's spent tokens still reach this session's totals.
		details.status = "failed";
		details.outcome = "failed";
		const text = reportMessage(
			`Subagent ${identity.id} failed`,
			`${outcome.error}${outcome.text ? `\n\nPartial answer:\n${outcome.text}` : ""}`,
			[failedNext(run.route, outcome.error, Boolean(outcome.text)), note],
		);
		return { isError: true, content: [{ type: "text" as const, text }], details, usage: outcome.usage };
	}
	details.status = "done";
	const reported = outcome.outcome;
	if (reported) details.outcome = reported;
	if (outcome.outcomeSource) details.outcomeSource = outcome.outcomeSource;
	const heading = reported ? `Subagent ${identity.id} reported ${reported}` : "";
	const typedFailure = identity.resultContract && (reported !== "done" || outcome.structured?.status !== "valid");
	return {
		...(typedFailure ? { isError: true } : {}),
		content: [
			{
				type: "text" as const,
				text: reportMessage(
					heading || `Subagent ${identity.id} finished`,
					withShot(details, outcome.text || "(subagent returned no text)"),
					[typedFailure ? `Result schema validation: ${outcome.structured?.error?.code ?? "unavailable"}.` : "", note],
				),
			},
		],
		details,
		usage: outcome.usage,
	};
}
