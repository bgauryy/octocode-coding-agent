import { limitsFor } from "./limits.ts";
import { leftInRecoveryBand } from "./recovery-band.ts";
import type { Api, Model } from "@octocodeai/octocode-ai";
import {
	type FeatureSetup,
	type FeatureContext,
	readsMessagesOnly,
	type SessionCompactEvent,
} from "../../core/features/index.ts";
import { contextReads, seenFiles } from "../files/reads.ts";
import type { FileGuard } from "../files/tool/guard.ts";
import { flushSessionRecords, scheduleSessionRecord } from "../history/archive/record.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { forkLineage, sessionRecordOf } from "./archive/session-record.ts";
import { sessionLineage, setSessionLineage } from "../history/archive.ts";
import { notify } from "../shared/commands.ts";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";
import { compactionThinking, reserveTokensFor } from "../shared/tokens.ts";
import { registerTurnBudget } from "./turn-budget.ts";
import { registerCompactOnDone } from "./on-done.ts";
import { ArchiveCapture, deliverArchivePointer, summaryLabel } from "./archive.ts";
import { cacheUnusable, PromptCacheLifetimes, prefixCached, promptCacheTtlMs, warmingDecision } from "./cache.ts";
import { startEarlySummary } from "./early-summary.ts";
import { registerPrewarmWatch } from "./prewarm-watch.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import { type AwaitsAnswer, expectsWake } from "./warm-wait.ts";
import { shellParserReady } from "../permission/shell/mutation.ts";
import { clearStaleResults, rewriteCause } from "./clearing.ts";
import { COMPACT_TOOL, CompactRequests } from "../native/tools/compact/tool.ts";
import { FallbackContinuity, latestCompaction } from "./continuity.ts";
import { contextBands, noticeContextUsage } from "../monitor/attention/context.ts";
import type { ContextEntry } from "./images.ts";
import { addFileToolOps } from "./file-tool-ops.ts";
import { restoreCandidates as pickRestoreCandidates } from "./restore-picks.ts";
import {
	contextTokens,
	fitsWindow,
	needsDownshiftCompaction,
	THRASH_MESSAGE,
	ThrashBreaker,
	toolDefinitionChars,
} from "./pacing.ts";
import { recordCompactionNote } from "./record.ts";
import { recordContextFiles } from "./restore-context.ts";
import { restoreLoadedSkills } from "./restore-skills.ts";
import { TooLargeRecovery } from "./recovery.ts";
import {
	deliverRestoredFiles,
	restoreLimits,
	type PendingRestore,
	RESTORE_SHARE,
	RESTORE_TOTAL_CHARS,
	type RestoreCandidate,
	settleRestoredFiles,
} from "./restore.ts";
import { liveStateLines } from "./live-state.ts";
import { addLedgerEdits } from "./edit-ledger.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { carryFileLists, summaryMethodOf, windowBudget, writeSummary } from "./summary.ts";
import { requestView } from "./request-view.ts";
import { sessionMirrorSettled } from "../../core/session-manager/mirror.ts";

/** Longest a forked session's start waits for its fork edge (`session-manager/mirror.ts`) before reading its lineage. */
const FORK_EDGE_WAIT_MS = 2_000;

/**
 * Tool results and call arguments stay verbatim until Octocode compacts (a long result is bounded and spilled to a file when
 * written, and one assistant message's results share a text budget), with two exceptions: after an idle gap longer than the prompt-cache lifetime the old results of re-fetchable
 * tools are replaced by placeholders naming their saved files (`clearing.ts`), and a repeated read of an unchanged file
 * gets a short note (`files/dedupe.ts`). Octocode also supplies prompt-cache lifetimes and warming decisions, strips
 * images from a request rejected as too large (HTTP 413, else the session is stuck), and writes the compaction summary
 * (`summary.ts`). Each compaction's summarized messages are also filed as a searchable Markdown segment once it
 * succeeded (`archive.ts`).
 */

/**
 * Files whose latest result in the context is among the `edited` entries (413 recovery replaced their images): their
 * content left the model's view, so the file guard asks for a fresh read before they are changed.
 */
function editedReadPaths(entries: ContextEntry[], edited: ReadonlySet<string>, cwd: string): string[] {
	return [...seenFiles(entries, cwd).values()].filter((seen) => edited.has(seen.id)).map((seen) => seen.file);
}

export { registerCompactTool } from "../native/tools/compact/tool.ts";
export { addFileToolOps } from "./file-tool-ops.ts";

/**
 * Returns the agent's compaction requests, for the `compact` tool (`registerCompactTool`). `parentId` is a subagent's
 * parent: a checkpoint keeps its mail to this agent word for word. `awaitsAnswer` says whether the agent waits for an
 * answer it asked for: while it does, an idle cache is kept warm for that answer.
 */
export function registerCompaction(
	api: FeatureSetup,
	guard: FileGuard,
	isSubagent = false,
	parentId?: string,
	awaitsAnswer: AwaitsAnswer = () => false,
): CompactRequests {
	// One assistant message's tool results share a text budget; the overflow is saved to a file (`compaction/turn-budget.ts`).
	registerTurnBudget(api);
	registerPrewarmWatch(api);
	const tooLarge = new TooLargeRecovery();
	const lifetimes = new PromptCacheLifetimes();
	const thrash = new ThrashBreaker();
	const archive = new ArchiveCapture();
	const continuity = new FallbackContinuity();
	const requests = new CompactRequests(thrash);
	const onDone = registerCompactOnDone(api, requests, isSubagent, (ctx) =>
		prefixCached(ctx.sessionManager, lifetimes.of(ctx.model), cacheEnv(ctx)),
	);
	const cacheEnv = (ctx: FeatureContext): NodeJS.ProcessEnv => ({
		[CACHE_RETENTION_ENV]: ctx.model
			? ctx.modelRegistry.getCachePolicy(ctx.model, [{ source: "session settings", values: api.settings.get() }])
					.options.cacheRetention
			: undefined,
	});
	/** The model a pending downshift compaction summarizes on (the one the context still fits). */
	let downshiftFrom: Model<Api> | undefined;
	let session: string | undefined;
	const work = runningWorkOf(api);
	api.bus.on("cache_warming_decision", async (event, ctx) =>
		warmingDecision(
			event,
			ctx,
			promptCacheTtlMs(lifetimes.of(ctx.model), cacheEnv(ctx)),
			Date.now(),
			isSubagent,
			event.continuationProbability < 1 && expectsWake(work, ctx, awaitsAnswer),
		),
	);
	api.bus.on("turn_end", async (event, ctx) => {
		lifetimes.observe(api, ctx, event.message, cacheEnv(ctx));
		thrash.turnEnded();
		onDone.turnEnd(ctx);
		noticeContextUsage(
			api,
			ctx,
			event.context.contextEntries.flatMap((entry) => entry.messages.map((message) => ({ message }))),
			compactionThinking(api),
			requests.toolRegistered && api.tools.getActive().includes(COMPACT_TOOL),
			latestCompaction(ctx.sessionManager)?.id,
			contextBands(api.settings.get()),
		)?.catch((error: unknown) => {
			if (ctx.hasUI) notify(ctx.ui, `The context usage notice failed (${errorMessage(error)}).`, "warning");
		});
		const current = ctx.sessionManager.getSessionId();
		if (current !== session) {
			session = current;
			tooLarge.reset();
		}
		const entries = event.context.contextEntries.flatMap((entry) =>
			entry.sourceEntry.type === "message" && entry.messages.length === 1
				? [{ id: entry.sourceEntry.id, message: entry.messages[0] }]
				: [],
		);
		const recovery = tooLarge.onTurnEnd(event.message, event.messageEntryId, entries, ctx);
		if (!recovery) return undefined;
		for (const file of editedReadPaths(entries, new Set(recovery.map((edit) => edit.targetId)), ctx.cwd))
			guard.forget(file);
		return { entries: [...event.entries, ...recovery] };
	});
	api.bus.on("agent_before_settle", async (event) =>
		tooLarge.shouldRetry(event.outcome) ? { continue: true } : undefined,
	);
	api.bus.on("agent_settled", async (event, ctx) => {
		thrash.runSettled();
		requests.settle(api, ctx, event.aborted);
	});
	// The files worked on in the summarized part, most recent first, come back after the compaction.
	let restoreCandidates: RestoreCandidate[] = [];
	let restoreBudget = RESTORE_TOTAL_CHARS;
	let pendingRestore: PendingRestore | undefined;
	/** When this process started its session: background work started earlier ended with an earlier process. */
	let workSince = Date.now();
	// Near the threshold the summary is requested beside the run, inside the session's cached request (`early-summary.ts`).
	api.bus.on("session_compact_prewarm", async (event, ctx) => {
		if (downshiftFrom || thrash.tripped()) return;
		// Without a usable cache the early request would bill the whole input beside the run, for a summary the compaction can request itself.
		startEarlySummary(api, event, ctx, cacheUnusable(ctx.sessionManager, lifetimes.of(ctx.model), cacheEnv(ctx)));
	});
	api.bus.on("session_before_compact", async (event, ctx) => {
		// The `compact` tool's request arrives as manual but counts as automatic; only threshold ones answer to the band.
		continuity.discard();
		onDone.begin(event.requestedBy === "item");
		if ((event.reason !== "manual" || requests.inFlight) && thrash.tripped(event.reason !== "threshold")) {
			recordCompactionNote(api, "thrash-stop", THRASH_MESSAGE);
			// While the context still fits the window, the run (and a prompt about to be sent) goes on; the refusal is a
			// failure, which the session reports as the compaction's error.
			if (requests.inFlight || (event.reason !== "overflow" && fitsWindow(ctx, toolDefinitionChars(api))))
				return { cancel: true, failure: THRASH_MESSAGE };
			if (ctx.hasUI) notify(ctx.ui, THRASH_MESSAGE, "error");
			// The abort also cancels this compaction, so the session drops a failure returned here: record it first.
			ctx.failRun(THRASH_MESSAGE);
			ctx.abort("internal");
			return { cancel: true };
		}
		archive.capture(event);
		restoreCandidates = await pickRestoreCandidates(event.preparation, ctx.cwd, event.branchEntries);
		// Sized for the window the context lands in (after a downshift, the smaller model's), with Octocode's reserve for it.
		restoreBudget = windowBudget(
			ctx.model?.contextWindow,
			event.preparation.settings.reserveTokens,
			RESTORE_SHARE,
			restoreLimits(ctx.model?.contextWindow).totalChars,
			ctx.model?.inputLimits?.maxInputTokens,
		);
		// The file lists know only Octocode's read/write/edit and drop a hook summary's lists: both are added first, so Octocode's
		// default summary (when Octocode's fails) has them too.
		addFileToolOps(event.preparation, ctx.cwd);
		carryFileLists(event.preparation, event.branchEntries);
		// This session's bash writes and its subagents' changes join the list, with a Recovery line saying whose they are.
		const ledger = await addLedgerEdits(event.preparation, ctx.cwd);
		const from = downshiftFrom;
		downshiftFrom = undefined;
		const cacheTtlMs = promptCacheTtlMs(lifetimes.of(ctx.model), cacheEnv(ctx));
		// Long instructions outlive short history: the instruction entry lasts the model's long tier.
		const instructionTtlMs = promptCacheTtlMs(lifetimes.of(ctx.model), { [CACHE_RETENTION_ENV]: "long" });
		return writeSummary(
			api,
			event,
			ctx,
			from,
			continuity,
			parentId,
			cacheTtlMs,
			() => [...ledger, ...liveStateLines(ctx, event.branchEntries, workSince)],
			instructionTtlMs,
		);
	});

	api.bus.on("session_start", async (_event, ctx) => {
		workSince = Date.now();
		tooLarge.reset();
		thrash.reset();
		requests.reset();
		onDone.reset();
		downshiftFrom = undefined;
		restoreCandidates = [];
		pendingRestore = undefined;
		archive.discard();
		continuity.discard();
		// A forked session's history before the fork is in its sources' archives: its own (`ownArchives`, the pointer).
		// The fork edge is written by the database writer: a fork made just now is read once it is acknowledged (bounded).
		if (ctx.sessionManager.getHeader()?.parentSession) await sessionMirrorSettled(FORK_EDGE_WAIT_MS);
		setSessionLineage(forkLineage(ctx.sessionManager));
		recordWarned = false;
	});
	// The session's record (goal, ending, repository) is rewritten after each run, so other sessions of the repository
	// can tell what it was for and how it ended (`archive` tool). A failure is warned about once and never thrown.
	let recordWarned = false;
	// The write runs in the background (the run's end does not wait for the disk), so the UI is taken now: the context
	// may be retired by the time it fails.
	api.bus.on("agent_end", async (_event, ctx) => {
		const ui = ctx.hasUI ? ctx.ui : undefined;
		const warn = (error: unknown) => {
			try {
				if (!recordWarned && ui)
					notify(ui, `The session record could not be written (${errorMessage(error)}).`, "warning");
			} catch {
				// A UI closed since the run ended has no one to tell.
			}
			recordWarned = true;
		};
		try {
			const record = sessionRecordOf(ctx.sessionManager, sessionLineage());
			if (record) scheduleSessionRecord(record).catch(warn);
		} catch (error) {
			warn(error);
		}
	});
	api.bus.on("session_shutdown", async () => {
		requests.reset();
		await flushSessionRecords();
	});
	// File contents summarized away by compaction, or on another branch, are no longer in context: the guard keeps only
	// the reads the context still shows, then the files worked on most recently are read back (and count as read).
	// Switching to a model whose window the context does not fit compacts first, on the previous model: the next
	// request on the new one would fail, and only the previous model can still read the whole history.
	api.bus.on("model_select", async (event, ctx) => {
		const reserve = reserveTokensFor(event.model, compactionThinking(api));
		if (
			!needsDownshiftCompaction(event.previousModel, event.model, contextTokens(ctx, toolDefinitionChars(api)), reserve)
		)
			return;
		downshiftFrom = event.previousModel;
		const reason = `The context does not fit ${event.model.id}'s window; compacting first on ${event.previousModel!.id}.`;
		recordCompactionNote(api, "downshift", reason);
		if (ctx.hasUI) notify(ctx.ui, reason, "info");
		ctx.compact({
			onError: () => {
				downshiftFrom = undefined;
			},
		});
	});
	api.bus.on("session_compact", async (event, ctx) => {
		const manual = event.reason === "manual" && !requests.inFlight;
		const item = onDone.compacted(() => event.compactionEntry.details);
		thrash.compacted(manual, item, leftInRecoveryBand(api, ctx));
		requests.compacted();
		const segment = archiveCompaction(api, archive, event, ctx);
		// After Octocode's default summary, what code appends to a summary follows it, archive pointer included; any other
		// summary that is not Octocode's gets only the pointer.
		const entry = event.compactionEntry;
		if (
			!(await continuity.deliver(api, entry)) &&
			segment !== undefined &&
			summaryMethodOf(entry.details) === undefined
		)
			await deliverArchivePointer(api, segment);
		guard.restore(contextReads(ctx));
		const pending = restoreCandidates;
		restoreCandidates = [];
		// The system prompt shows the project context files whole: they count as read and are not sent again.
		const contextHeld = recordContextFiles(guard, ctx.getSystemPromptOptions?.().contextFiles ?? []);
		pendingRestore = await deliverRestoredFiles(api, pending, ctx, restoreBudget, compactionThinking(api), contextHeld);
		// The workflows loaded last come back whole too: a pointer alone is seldom followed (`restore-skills.ts`).
		await restoreLoadedSkills(api, ctx);
	});
	api.bus.on("session_compact_failed", async (event) => {
		onDone.failed();
		if (event.aborted && event.reason === "manual") requests.reset();
		archive.discard();
		continuity.discard();
	});
	// The restored files count as read from the first model call that carries them (Octocode may hold the message until the
	// running turn ends).
	// Never edits a message: `requestView` returns copies of the ones it changes (`thinking.ts`, `clearing.ts`).
	api.bus.on(
		"context",
		readsMessagesOnly(async (event, ctx) => {
			// Before every request, in a run or at its start: old results are cleared when this request rewrites the cache anyway
			// (an idle gap or a long tool past its lifetime, a compaction, a model switch, a folded system update) or when clearing them costs
			// less than re-sending them (`clearing-cost.ts`). A bash result is cleared only when its command is read-only, which
			// the bash parse must confirm: load it first.
			await shellParserReady();
			const usage = ctx.getContextUsage();
			clearStaleResults(api, ctx, guard, promptCacheTtlMs(lifetimes.of(ctx.model), cacheEnv(ctx)), {
				rewrite: rewriteCause(event.transcript ?? event.messages, ctx.model),
				// Compaction summarizes the old results at the threshold, before the window fills. A usage without a known
				// window reports 0; one without a threshold falls back to the window.
				contextWindow:
					usage?.compactionThreshold !== undefined && usage.compactionThreshold > 0
						? usage.compactionThreshold
						: usage !== undefined && usage.contextWindow > 0
							? usage.contextWindow
							: ctx.model?.contextWindow,
				...(typeof usage?.tokens === "number" ? { contextTokens: usage.tokens } : {}),
				keep: limitsFor(api, ctx.model).clearing,
			});
			if (pendingRestore && settleRestoredFiles(event.messages, pendingRestore, guard)) pendingRestore = undefined;
			// Every request shows the messages as `requestView` describes; the cache-sharing summary request uses it too.
			const messages = requestView(event.messages, ctx.sessionManager, ctx.model);
			return messages === event.messages ? undefined : { messages };
		}),
	);
	api.bus.on("session_tree", async (_event, ctx) => {
		tooLarge.reset();
		thrash.reset();
		requests.reset();
		downshiftFrom = undefined;
		restoreCandidates = [];
		pendingRestore = undefined;
		continuity.discard();
		guard.restore(contextReads(ctx));
	});
	return requests;
}

/**
 * Files the messages captured for the compaction that just succeeded (`ArchiveCapture`), labelled with what its summary
 * says, and returns the segment written. A summary Octocode did not write has no pointer to the archive in its Recovery
 * section, so the caller sends one. A failure is reported and recorded, never thrown: the compaction itself is done.
 */
function archiveCompaction(
	api: FeatureSetup,
	archive: ArchiveCapture,
	event: SessionCompactEvent,
	ctx: FeatureContext,
): number | undefined {
	if (!ctx.sessionManager.getSessionFile()) {
		archive.discard();
		return undefined;
	}
	if (!archive.captured) return undefined;
	try {
		const entry = event.compactionEntry;
		const written = archive.write(
			entry,
			ctx.sessionManager.getSessionId(),
			summaryLabel(splitSummary(entry.summary).body),
			summaryMethodOf(entry.details) ?? (entry.fromHook ? "feature" : "octocode-default"),
		);
		return written?.n;
	} catch (error) {
		const reason = `The compaction succeeded, but its messages could not be archived (${errorMessage(error)}).`;
		recordCompactionNote(api, "archive-failed", reason);
		if (ctx.hasUI) notify(ctx.ui, reason, "warning");
		return undefined;
	}
}
