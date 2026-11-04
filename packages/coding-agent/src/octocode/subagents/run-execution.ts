import type { AgentEnd } from "../team/panel-state.ts";
import type { ReportStatus } from "../instructions/report.ts";
import { AgentToolExecutionError } from "@octocodeai/octocode-agent-core";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { formatCost, formatDuration, shortPath, toolCallCount } from "../shared/format.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { reportRef } from "../shared/references.ts";
import { firstLine } from "../shared/util.ts";
import type { AgentRuns, Run } from "./claim.ts";
import type { BackgroundRun } from "./command.ts";
import { withStopFacts } from "./budget.ts";
import { hintEnd, hintOnStop, stopReason } from "./end-hint.ts";
import { pendingReportsDir, type Report, savePendingReport } from "./handoff/pending.ts";
import type { AwaitedReply } from "./linger.ts";
import { providerHealth } from "./provider-health.ts";
import type { runSubagent } from "./process.ts";
import { USER_STOP } from "./process/outcome.ts";
import { capitalize, compactionLabel, deniedLabel, doneSummary, noticeLines } from "./render.ts";
import { failedNext, foregroundExtras, PERMISSION_STOP, ranOn, reportMessage, stoppedError } from "./report-text.ts";
import { unavailableResult } from "./result-schema.ts";
import type { RunDetails } from "./run-types.ts";
import { beginRun, finishRun, type RunEnd } from "./run-audit.ts";
import { stopFacts } from "./stop-facts.ts";
import { reportFacts, runFooter, withShot } from "./tracking.ts";

type Outcome = Awaited<ReturnType<typeof runSubagent>>;

/** ` · cite as report:<id>`: how a later task or external prompt passes this report on without retyping it. */
const citable = (id: string): string => ` · cite as ${reportRef(id)}`;

/** Whom the run's unanswered asks wait on: its parent (`asks`) first, else its peers (the team's record); it lingers while they wait. */
function awaitedReply(runs: AgentRuns, id: string, details: RunDetails): AwaitedReply | undefined {
	if (details.asks?.some((ask) => !ask.answer)) return "parent";
	// An unreadable team database counts no peer asks (`Team.unansweredPeerAsks`), leaving the parent's record to decide.
	return runs.team.unansweredPeerAsks(id) > 0 ? "peer" : undefined;
}

/**
 * The report answers whatever the parent asked this child and it read: they stop counting as unanswered. Housekeeping on
 * the way to the report, so a failure here costs at most a stale notice and never the report.
 */
function closeAnswered(runs: AgentRuns, id: string): void {
	try {
		runs.team.closeQuestionsTo(id);
	} catch {
		// The questions stay open; the report is delivered either way.
	}
}

/**
 * What the child sent before it finished goes to the parent's model before its report: the mail tick may be up to a second
 * away, and a parent that ends with the report (a headless run) would never read it. Fails open like `closeAnswered`.
 */
function readMailFirst(runs: AgentRuns): void {
	try {
		runs.team.deliverMail();
	} catch {
		// The next tick delivers it.
	}
}

/**
 * Runs the subagent in the background; its report (or why it stopped) arrives as a message, and then it gives its slot
 * back. `finish` gets the outcome when there is a report, so the parent's own notes on it (its backlog item) ride in the footer.
 */
export function startBackground(
	runs: AgentRuns,
	run: Run,
	details: RunDetails,
	task: string,
	launch: (signal: AbortSignal) => Promise<Outcome>,
	finish: (outcome?: Outcome) => Promise<string>,
	sessionId: string,
	linger?: (outcome?: ReportStatus, awaited?: AwaitedReply) => string,
): void {
	const { background, read } = runs;
	const { identity } = run;
	const session = runs.session;
	// A report that arrives after its session ended (a reload, a switch) is kept for the next start of that Octocode session.
	const reports = {
		add: (report: Report) =>
			session === runs.session
				? runs.reports.add(report)
				: savePendingReport(pendingReportsDir(sessionId), identity.id, report),
	};
	const controller = new AbortController();
	const entry: BackgroundRun = { controller, done: Promise.resolve() };
	background.set(identity.id, entry);
	hintOnStop(runs, identity.id, entry);
	beginRun(runs, run);
	runs.changed();
	read.track(identity.id, identity.scratch);
	// The parent may have many runs going: every report names the agent, its role and its goal.
	const who = `${identity.id} (${identity.role}: ${identity.goal})`;
	// For the renderer: the expanded report shows the whole prompt.
	const shown = { task, goal: identity.goal ?? "", profile: identity.role ?? "" };
	let end: AgentEnd | undefined;
	let audit: RunEnd | undefined;
	entry.done = (async () => {
		try {
			const outcome = withStopFacts(await launch(controller.signal), details, runs.team);
			providerHealth.noteRun(run.route.model, outcome.error);
			if (outcome.error) hintEnd(runs, identity.id, "failed");
			const note = await finish(outcome);
			// The latest report determines the outcome; a failed follow-up overrides earlier success.
			const reported = outcome.error ? "failed" : outcome.outcome;
			if (reported) details.outcome = reported;
			const source = outcome.error ? undefined : outcome.outcomeSource;
			if (source) details.outcomeSource = source;
			if (outcome.structured) details.structured = outcome.structured;
			if (outcome.reportArtifact) details.reportArtifact = outcome.reportArtifact;
			audit = {
				reason: outcome.error ? "failed" : "completed",
				error: outcome.error,
				outcome: reported,
				outcomeSource: source,
				reportPath: outcome.reportArtifact?.path,
			};
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
			const head = `${
				outcome.error
					? `Background subagent ${who} failed`
					: `Background subagent ${who} ${reported ? `reported ${reported}` : "finished"} (${stats})`
			}${citable(identity.id)}`;
			const durationMs = Date.now() - details.startedAt;
			const summary = outcome.error ? `Failed: ${firstLine(outcome.error)}` : doneSummary(details, durationMs);
			end = {
				outcome: outcome.error ? "failed" : (reported ?? "done"),
				headline: firstLine(outcome.error ?? outcome.text),
			};
			const alreadyRead = read.consume(identity.id, outcome.reportArtifact);
			const next = outcome.error ? failedNext(run.route, outcome.error, Boolean(outcome.text)) : "";
			const notices = noticeLines(details).join("\n");
			// A successful run that lingers stays reachable: the report says for how long and how to use or end it. One with an unanswered ask to its parent or a peer lingers whatever it reported.
			const reachable = outcome.error ? "" : (linger?.(reported, awaitedReply(runs, identity.id, details)) ?? "");
			// The child's own notices sit with its words, inside the fence: only the parent's counts ride in the footer.
			const text = [outcome.text || "(no text)", notices].filter(Boolean).join("\n\n");
			const body = outcome.error ? `Error: ${outcome.error}\n${text}` : text;
			const shot = details.shot ? `(Last screenshot: ${shortPath(details.shot)})` : "";
			if (!outcome.error) closeAnswered(runs, identity.id);
			readMailFirst(runs);
			reports.add({
				content: reportMessage(head, body, [
					...(typedFailure ? [`Result schema validation: ${outcome.structured?.error?.code ?? "unavailable"}.`] : []),
					// A failure's `next` already names the route.
					next || ranOn(run.route),
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
			if (!by) hintEnd(runs, identity.id, "failed");
			audit = {
				reason: by ? stopReason(by) : "failed",
				error: by ? undefined : errorMessage(error),
				outcome: by ? undefined : "failed",
			};
			const reason =
				by === USER_SENDER ? "cancelled by the user" : by ? `stopped by ${by}` : `stopped: ${errorMessage(error)}`;
			const reachable = by === PERMISSION_STOP ? (linger?.() ?? "") : "";
			end = { outcome: by ? "stopped" : "failed", headline: reason };
			reports.add({
				// A stop someone asked for is the parent's own word; any other cause (a crash, a stall) quotes the child's output.
				content: by
					? `Background subagent ${who} ${reason}${by === PERMISSION_STOP ? stopFacts(details, runs.team) : ""}${note}${reachable}`
					: reportMessage(
							`Background subagent ${who} stopped${citable(identity.id)}`,
							[errorMessage(error), ...noticeLines(details)].join("\n\n"),
							[ranOn(run.route), ...runFooter(details, true), note, reachable],
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
			if (audit) finishRun(runs, identity.id, audit);
			if (end) runs.ended?.(identity.id, end);
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
	finish: (outcome?: Outcome) => Promise<string>,
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
	hintOnStop(runs, identity.id, entry);
	beginRun(runs, run);
	let outcome: Outcome;
	try {
		outcome = withStopFacts(await launch(controller.signal), details, runs.team);
		providerHealth.noteRun(run.route.model, outcome.error);
		if (outcome.error) hintEnd(runs, identity.id, "failed");
	} catch (error) {
		// An Esc aborts the controller without `stoppedBy`: that stop already left its hint.
		if (!entry.stoppedBy && !controller.signal.aborted) hintEnd(runs, identity.id, "failed");
		const note = `${entry.stoppedBy === PERMISSION_STOP ? stopFacts(details, runs.team) : ""}${await finish()}${entry.stoppedBy ? "" : foregroundExtras(details, true)}`;
		const reason = entry.stoppedBy ? stoppedError(identity.id, entry.stoppedBy) : error;
		finishRun(runs, identity.id, {
			reason: entry.stoppedBy || controller.signal.aborted ? stopReason(entry.stoppedBy) : "failed",
			error: entry.stoppedBy ? undefined : errorMessage(error),
			outcome: entry.stoppedBy ? undefined : "failed",
		});
		const text = `${errorMessage(reason)}${note}`;
		// The result keeps the run's details, so the session records the child (its folder, a startup failure) for `resume`.
		details.status = "failed";
		if (!entry.stoppedBy) details.outcome = "failed";
		throw new AgentToolExecutionError(text, { content: [{ type: "text", text }], details });
	} finally {
		signal?.removeEventListener("abort", abort);
		runs.foreground.delete(identity.id);
	}
	const note = `${await finish(outcome)}${warning}${foregroundExtras(details, Boolean(outcome.error))}`;
	if (!outcome.error) closeAnswered(runs, identity.id);
	if (outcome.structured) details.structured = outcome.structured;
	if (outcome.reportArtifact) details.reportArtifact = outcome.reportArtifact;
	finishRun(runs, identity.id, {
		reason: outcome.error ? "failed" : "completed",
		error: outcome.error,
		outcome: outcome.error ? "failed" : outcome.outcome,
		outcomeSource: outcome.error ? undefined : outcome.outcomeSource,
		reportPath: outcome.reportArtifact?.path,
	});
	if (outcome.error) {
		// An error result rather than a throw, so the child's spent tokens still reach this session's totals.
		details.status = "failed";
		details.outcome = "failed";
		const text = reportMessage(
			`Subagent ${identity.id} failed${citable(identity.id)}`,
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
					`${heading || `Subagent ${identity.id} finished`}${citable(identity.id)}`,
					withShot(details, outcome.text || "(subagent returned no text)"),
					[
						typedFailure ? `Result schema validation: ${outcome.structured?.error?.code ?? "unavailable"}.` : "",
						ranOn(run.route),
						note,
					],
				),
			},
		],
		details,
		usage: outcome.usage,
	};
}
