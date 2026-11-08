import path from "node:path";
import type { Api, Model } from "@octocodeai/octocode-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "../../core/features/index.ts";
import {
	appliedFileOutcomes,
	contextReads,
	seenFiles,
	sessionCleared,
	sessionClearedAt,
	type WorkedFile,
} from "../files/reads.ts";
import type { FileGuard } from "../files/tool/guard.ts";
import { writeSessionRecord } from "../shared/archive/record.ts";
import { resolveToolPath } from "../shared/home.ts";
import { recordedLocalReads } from "../shared/local-reads.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { forkLineage, sessionRecordOf } from "./archive/session-record.ts";
import { sessionLineage, setSessionLineage } from "../shared/archive.ts";
import { notify } from "../shared/commands.ts";
import { CACHE_RETENTION_ENV } from "../../../../common/src/env.ts";
import { compactionThinking, reserveTokensFor } from "../shared/tokens.ts";
import { registerTurnBudget } from "../shared/turn-budget.ts";
import { ArchiveCapture, deliverArchivePointer, summaryLabel } from "./archive.ts";
import { PromptCacheLifetimes, promptCacheTtlMs, warmingDecision } from "./cache.ts";
import { shellParserReady } from "../permission/shell/mutation.ts";
import { clearStaleResults, prefixRewritten } from "./clearing.ts";
import { COMPACT_TOOL, CompactRequests } from "./compact-tool.ts";
import { FallbackContinuity, latestCompaction, withoutCarriedNotes } from "./continuity.ts";
import { noticeContextUsage } from "./context-notice.ts";
import { type ContextEntry, parts } from "./images.ts";
import {
	contextTokens,
	fitsWindow,
	needsDownshiftCompaction,
	THRASH_MESSAGE,
	ThrashBreaker,
	toolDefinitionChars,
} from "./pacing.ts";
import { recordCompactionNote } from "./record.ts";
import { TooLargeRecovery } from "./recovery.ts";
import {
	deliverRestoredFiles,
	type PendingRestore,
	RESTORE_SHARE,
	RESTORE_TOTAL_CHARS,
	recentFiles,
	settleRestoredFiles,
} from "./restore.ts";
import { liveStateLines } from "./live-state.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { carryFileLists, summaryMethodOf, windowBudget, writeSummary } from "./summary.ts";
import { requestMessages } from "./thinking.ts";

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

export { registerCompactTool } from "./compact-tool.ts";

/**
 * Returns the agent's compaction requests, for the `compact` tool (`registerCompactTool`). `parentId` is a subagent's
 * parent: a checkpoint keeps its mail to this agent word for word.
 */
export function registerCompaction(
	api: ExtensionAPI,
	guard: FileGuard,
	isSubagent = false,
	parentId?: string,
): CompactRequests {
	// One assistant message's tool results share a text budget; the overflow is saved to a file (`shared/turn-budget.ts`).
	registerTurnBudget(api);
	const tooLarge = new TooLargeRecovery();
	const lifetimes = new PromptCacheLifetimes();
	const thrash = new ThrashBreaker();
	const archive = new ArchiveCapture();
	const continuity = new FallbackContinuity();
	const requests = new CompactRequests(thrash);
	const cacheEnv = (ctx: ExtensionContext): NodeJS.ProcessEnv => ({
		[CACHE_RETENTION_ENV]: ctx.model
			? ctx.modelRegistry.getCachePolicy(ctx.model, [{ source: "session settings", values: api.getSettings() }]).options
					.cacheRetention
			: undefined,
	});
	/** The model a pending downshift compaction summarizes on (the one the context still fits). */
	let downshiftFrom: Model<Api> | undefined;
	let session: string | undefined;
	api.on("cache_warming_decision", async (event, ctx) =>
		warmingDecision(event, ctx, promptCacheTtlMs(lifetimes.of(ctx.model), cacheEnv(ctx)), Date.now(), isSubagent),
	);
	api.on("turn_end", async (event, ctx) => {
		lifetimes.observe(api, ctx, event.message, cacheEnv(ctx));
		thrash.turnEnded();
		noticeContextUsage(
			api,
			ctx,
			event.context.contextEntries.flatMap((entry) => entry.messages.map((message) => ({ message }))),
			compactionThinking(api),
			requests.toolRegistered && api.getActiveTools().includes(COMPACT_TOOL),
		);
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
	api.on("agent_before_settle", async (event) =>
		tooLarge.shouldRetry(event.outcome) ? { continue: true } : undefined,
	);
	api.on("agent_settled", async (event, ctx) => {
		thrash.runSettled();
		requests.settle(api, ctx, event.aborted);
	});
	// The files worked on in the summarized part, most recent first, come back after the compaction.
	let restoreCandidates: WorkedFile[] = [];
	let restoreBudget = RESTORE_TOTAL_CHARS;
	let pendingRestore: PendingRestore | undefined;
	/** When this process started its session: background work started earlier ended with an earlier process. */
	let workSince = Date.now();
	api.on("session_before_compact", async (event, ctx) => {
		// The agent's own request (`compact` tool) arrives as a manual compaction but counts as automatic.
		continuity.discard();
		if ((event.reason !== "manual" || requests.inFlight) && thrash.tripped()) {
			recordCompactionNote(api, "thrash-stop", THRASH_MESSAGE);
			// While the context still fits the window, the run (and a prompt about to be sent) goes on; the refusal is a
			// failure, which the session reports as the compaction's error.
			if (requests.inFlight || (event.reason !== "overflow" && fitsWindow(ctx, toolDefinitionChars(api))))
				return { cancel: true, failure: THRASH_MESSAGE };
			if (ctx.hasUI) notify(ctx.ui, THRASH_MESSAGE, "error");
			ctx.abort("internal");
			return { cancel: true };
		}
		archive.capture(event);
		restoreCandidates = recentFiles(event.preparation, ctx.cwd);
		// Sized for the window the context lands in (after a downshift, the smaller model's), with Octocode's reserve for it.
		restoreBudget = windowBudget(
			ctx.model?.contextWindow,
			event.preparation.settings.reserveTokens,
			RESTORE_SHARE,
			RESTORE_TOTAL_CHARS,
		);
		// The file lists know only Octocode's read/write/edit and drop a hook summary's lists: both are added first, so Octocode's
		// default summary (when Octocode's fails) has them too.
		addFileToolOps(event.preparation, ctx.cwd);
		carryFileLists(event.preparation, event.branchEntries);
		const from = downshiftFrom;
		downshiftFrom = undefined;
		const cacheTtlMs = promptCacheTtlMs(lifetimes.of(ctx.model), cacheEnv(ctx));
		return writeSummary(api, event, ctx, from, continuity, parentId, cacheTtlMs, () =>
			liveStateLines(ctx, event.branchEntries, workSince),
		);
	});

	api.on("session_start", async (_event, ctx) => {
		workSince = Date.now();
		tooLarge.reset();
		thrash.reset();
		requests.reset();
		downshiftFrom = undefined;
		restoreCandidates = [];
		pendingRestore = undefined;
		archive.discard();
		continuity.discard();
		// A forked session's history before the fork is in its sources' archives: its own (`ownArchives`, the pointer).
		setSessionLineage(forkLineage(ctx.sessionManager));
		recordWarned = false;
	});
	// The session's record (goal, ending, repository) is rewritten after each run, so other sessions of the repository
	// can tell what it was for and how it ended (`archive` tool). A failure is warned about once and never thrown.
	let recordWarned = false;
	api.on("agent_end", async (_event, ctx) => {
		try {
			const record = sessionRecordOf(ctx.sessionManager, sessionLineage());
			if (record) writeSessionRecord(record);
		} catch (error) {
			if (!recordWarned && ctx.hasUI)
				notify(ctx.ui, `The session record could not be written (${errorMessage(error)}).`, "warning");
			recordWarned = true;
		}
	});
	// File contents summarized away by compaction, or on another branch, are no longer in context: the guard keeps only
	// the reads the context still shows, then the files worked on most recently are read back (and count as read).
	// Switching to a model whose window the context does not fit compacts first, on the previous model: the next
	// request on the new one would fail, and only the previous model can still read the whole history.
	api.on("model_select", async (event, ctx) => {
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
	api.on("session_compact", async (event, ctx) => {
		thrash.compacted(event.reason === "manual" && !requests.inFlight);
		requests.compacted();
		const segment = archiveCompaction(api, archive, event, ctx);
		// After Octocode's default summary, what code appends to a summary follows it, archive pointer included; any other
		// summary that is not Octocode's gets only the pointer.
		const entry = event.compactionEntry;
		if (!continuity.deliver(api, entry) && segment !== undefined && summaryMethodOf(entry.details) === undefined)
			deliverArchivePointer(api, segment);
		guard.restore(contextReads(ctx));
		const pending = restoreCandidates;
		restoreCandidates = [];
		pendingRestore = deliverRestoredFiles(api, pending, ctx, restoreBudget, compactionThinking(api));
	});
	api.on("session_compact_failed", async () => {
		archive.discard();
		continuity.discard();
	});
	// The restored files count as read from the first model call that carries them (Octocode may hold the message until the
	// running turn ends).
	api.on("context", async (event, ctx) => {
		// Before every request, in a run or at its start: when the cache was last used longer ago than its lifetime (an idle
		// gap, or a long tool in the run), this request rewrites it anyway, so old results are cleared first. A bash result is
		// cleared only when its command is read-only, which the bash parse must confirm: load it first.
		await shellParserReady();
		clearStaleResults(api, ctx, guard, promptCacheTtlMs(lifetimes.of(ctx.model), cacheEnv(ctx)), {
			rewrite: prefixRewritten(event.messages, ctx.model),
			contextWindow: ctx.model?.contextWindow,
		});
		if (pendingRestore && settleRestoredFiles(event.messages, pendingRestore, guard)) pendingRestore = undefined;
		// Every request shows the results cleared on this branch as their placeholders, the same way each time, no
		// thinking a compaction made stale (`thinking.ts`) and no continuity message a later compaction carried on.
		const latest = latestCompaction(ctx.sessionManager);
		const messages = requestMessages(
			withoutCarriedNotes(event.messages, latest?.id, summaryMethodOf(latest?.details) !== undefined),
			ctx.model,
			sessionCleared(ctx.sessionManager),
			sessionClearedAt(ctx.sessionManager),
		);
		return messages === event.messages ? undefined : { messages };
	});
	api.on("session_tree", async (_event, ctx) => {
		tooLarge.reset();
		restoreCandidates = [];
		pendingRestore = undefined;
		continuity.discard();
		guard.restore(contextReads(ctx));
	});
	return requests;
}

type Preparation = SessionBeforeCompactEvent["preparation"];

/**
 * Files the messages captured for the compaction that just succeeded (`ArchiveCapture`), labelled with what its summary
 * says, and returns the segment written. A summary Octocode did not write has no pointer to the archive in its Recovery
 * section, so the caller sends one. A failure is reported and recorded, never thrown: the compaction itself is done.
 */
function archiveCompaction(
	api: ExtensionAPI,
	archive: ArchiveCapture,
	event: SessionCompactEvent,
	ctx: ExtensionContext,
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
			summaryMethodOf(entry.details) ?? (entry.fromHook ? "extension" : "pi-default"),
		);
		return written?.n;
	} catch (error) {
		const reason = `The compaction succeeded, but its messages could not be archived (${errorMessage(error)}).`;
		recordCompactionNote(api, "archive-failed", reason);
		if (ctx.hasUI) notify(ctx.ui, reason, "warning");
		return undefined;
	}
}

/**
 * Adds every path the `file` tool changed in the summarized messages to Octocode's modified-file list (in place). A call's
 * result is found by `toolCallId`; a path counts only when the call succeeded and its outcome is `ok`, read from the
 * outcome itself (`appliedFileOutcomes`), so a `patch` call counts as a `queries` call does (a call where every query
 * failed has `isError` and no details). Adds every file Octocode's local tools read (their verified `details.localReads`,
 * as `seenFiles` reads them; native sessions have no `read` tool) to the read-file list. Those paths are absolute, so one
 * that a call changed under a relative path leaves that list here: `computeFileLists` compares the spellings.
 */
export function addFileToolOps(
	preparation: Pick<Preparation, "fileOps" | "messagesToSummarize" | "turnPrefixMessages">,
	cwd: string,
): void {
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const results = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (typeof message.toolCallId === "string") results.set(message.toolCallId, message);
		if (!message.isError)
			for (const read of recordedLocalReads(message.details)) preparation.fileOps.read.add(read.file);
	}
	for (const message of messages) {
		for (const part of parts(message)) {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== "file") continue;
			const result = typeof part.id === "string" ? results.get(part.id) : undefined;
			if (!result || result.isError === true) continue;
			for (const outcome of appliedFileOutcomes(result.details)) preparation.fileOps.edited.add(outcome.path);
		}
	}
	const { read, edited, written } = preparation.fileOps;
	const changed = new Set([...edited, ...written].map((file) => resolveToolPath(cwd, file)));
	for (const file of read) if (path.isAbsolute(file) && changed.has(file)) read.delete(file);
}
