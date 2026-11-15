import { type ManualCompactionOptions, validateCompactionInstructions } from "../compaction/manual-options.ts";
/**
 * Manual and automatic compaction of a session: their abort controllers, events and failure
 * accounting around the shared compaction core (`session-compaction.ts`); the default summary is `default-compaction.ts`.
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai/compat";
import { formatNoModelSelectedMessage } from "../auth-guidance.ts";
import type { CacheWarmer } from "../cache-warmer.ts";
import {
	type CompactionResult,
	CompactionFitError,
	explainNothingToCompact,
	prepareCompaction,
	summaryStreamWatcher,
} from "../compaction/index.ts";
import type { SessionCompactFailedEvent } from "../features/index.ts";
import { type CompactionHost, runCompaction } from "../session-compaction.ts";
import type { SessionInternals } from "./host.ts";
import { AutoCompactionLimit } from "./auto-compaction-limit.ts";
import { CompactionPrewarm } from "./compaction-prewarm.ts";
import { summaryRequestPolicy } from "./compaction-summary-request.ts";
import { recordRunFailure } from "./run-outcome.ts";

/** A manual compaction had nothing to summarize. The message stays the SDK/RPC error text; interactive mode shows it as a status. */
export class NothingToCompactError extends Error {
	/** The short, friendly line a UI shows instead of the error. */
	readonly notice: string;

	constructor(message: string, notice: string) {
		super(message);
		this.notice = notice;
		this.name = "NothingToCompactError";
	}
}

export interface CompactionControlHost extends Pick<
	SessionInternals,
	"session" | "run" | "emit" | "refreshContext" | "resolveIdleWaitIfIdle"
> {
	readonly cacheWarmer: Pick<CacheWarmer, "cancel"> | undefined;
	forcedSystemPrompt(): string | undefined;
	/** The session's default summary (`_runDefaultCompaction`). */
	summarize: CompactionHost["summarize"];
	/** Starts the delivery of input held during a manual compaction; never throws or waits (`releaseHeldInput`). */
	releaseHeldInput(): void;
}

export class SessionCompaction {
	private readonly _autoCompactionLimit = new AutoCompactionLimit();
	private readonly _prewarm = new CompactionPrewarm();
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;

	private readonly host: CompactionControlHost;

	constructor(host: CompactionControlHost) {
		this.host = host;
	}

	/** Whether manual compaction is running. */
	get isManualRunning(): boolean {
		return this._compactionAbortController !== undefined;
	}

	/** Whether manual or automatic compaction is running. */
	get isRunning(): boolean {
		return this._autoCompactionAbortController !== undefined || this._compactionAbortController !== undefined;
	}

	/** The session as the shared compaction core (`session-compaction.ts`) sees it. */
	private _compactionHost(): CompactionHost {
		const { session } = this.host;
		return {
			sessionManager: session.sessionManager,
			extensionRunner: session.extensionRunner,
			summarize: (...args) => this.host.summarize(...args),
			summaryRequest: (reason) => summaryRequestPolicy(this.host, reason),
			refreshContext: () => this.host.refreshContext(),
		};
	}

	async emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		const runner = this.host.session.extensionRunner;
		if (runner.hasHandlers("session_compact_failed")) {
			await runner.emit({
				type: "session_compact_failed",
				...event,
			});
		}
	}

	/**
	 * Overflow recovery hid the failed attempt and then could not compact: report it, as a failed recovery would be,
	 * instead of ending the run without an explanation.
	 */
	private async _recoveryNotStarted(cause: string): Promise<void> {
		const errorMessage = `Context overflow recovery failed: ${cause}. Try reducing context or switching to a larger-context model.`;
		recordRunFailure(this.host.run.outcome, errorMessage);
		this.host.emit({
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage,
		});
		await this.emitSessionCompactFailed({
			reason: "overflow",
			errorMessage,
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this.host.resolveIdleWaitIfIdle();
	}

	async compact(options?: ManualCompactionOptions): Promise<CompactionResult> {
		const customInstructions = validateCompactionInstructions(options?.customInstructions);
		const { session } = this.host;
		await session.abort("internal");
		this._prewarm.drop();
		// Nothing to summarize is an answer, not a failure: it throws before any compaction event, so no frontend reports it.
		const model = session.model;
		const settings = model
			? session.settingsManager.getCompactionSettings(
					model,
					session.routedModel?.thinkingLevel ?? session.thinkingLevel,
				)
			: undefined;
		const pathEntries = session.sessionManager.getBranch();
		const preparation = settings && prepareCompaction(pathEntries, settings);
		if (settings && !preparation) {
			if (pathEntries[pathEntries.length - 1]?.type === "compaction") {
				throw new NothingToCompactError("Already compacted", "Already compacted");
			}
			const why = explainNothingToCompact(pathEntries, settings.keepRecentTokens);
			throw new NothingToCompactError(why.message, why.notice);
		}
		// A local reference: a later clear (or a listener error) must not leave the catch without its signal.
		const controller = new AbortController();
		this._compactionAbortController = controller;
		this.host.emit({ type: "compaction_start", reason: "manual" });
		const outcome = { fromExtension: false, cancelledByExtension: false };
		let compactionResult: CompactionResult;

		try {
			if (!model || !settings || !preparation) {
				throw new Error(formatNoModelSelectedMessage());
			}
			// Only a compaction that runs replaces the cached prefix; "nothing to compact" keeps the warm entry.
			this.host.cacheWarmer?.cancel();

			compactionResult = await runCompaction(this._compactionHost(), {
				reason: "manual",
				customInstructions,
				willRetry: false,
				model,
				contextWindow: session.model?.contextWindow ?? model.contextWindow,
				reserveTokens: settings.reserveTokens,
				preparation,
				branchEntries: pathEntries,
				signal: controller.signal,
				// A cancel during the hook stops before the default summary starts a request of its own.
				checkAbort: () => {
					if (controller.signal.aborted) throw new Error("Compaction cancelled");
				},
				outcome,
			});
			this._autoCompactionLimit.succeeded();
			this._prewarm.reset();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = controller.signal.aborted || outcome.cancelledByExtension;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this.host.emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this.emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension: outcome.fromExtension,
			});
			this.host.releaseHeldInput();
			throw error;
		} finally {
			this._clearManualCompactionState();
		}
		// The compaction is saved. compaction_end listeners may submit queued prompts, so they run after the idle state
		// is exposed (cleared above), and a listener error can no longer report this compaction as failed.
		this.host.emit({
			type: "compaction_end",
			reason: "manual",
			result: compactionResult,
			aborted: false,
			willRetry: false,
		});
		this.host.releaseHeldInput();
		return compactionResult;
	}

	/** Plans the coming threshold compaction once `tokens` nears the threshold (`compaction-prewarm.ts`); shows nothing. */
	prewarm(tokens: number, model: Model<any>, thinking?: ThinkingLevel): void {
		const { session } = this.host;
		if (this.isRunning) return;
		const settings = session.settingsManager.getCompactionSettings(
			model,
			thinking ?? session.routedModel?.thinkingLevel ?? session.thinkingLevel,
		);
		const forced = this.host.forcedSystemPrompt();
		this._prewarm.dropIfStale(model, settings, forced);
		if (!this._prewarm.due(tokens, model, settings)) return;
		this._prewarm.start(session.sessionManager, session.extensionRunner, model, settings, {
			forceSystemPrompt: forced,
			watch: summaryStreamWatcher({ idleMs: session.settingsManager.getHttpIdleTimeoutMs() }),
			retry: session.settingsManager.getRetrySettings(),
			callbacks: {},
		});
	}

	/** Cancel in-progress compaction (manual or auto). */
	abort(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
		this._prewarm.drop();
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @param targetThinking The thinking level of the request being prepared, when routing chose it
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	async runAuto(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		targetModel?: Model<any>,
		targetThinking?: ThinkingLevel,
	): Promise<boolean> {
		const { session } = this.host;
		const model = targetModel ?? session.model;
		const settings = session.settingsManager.getCompactionSettings(
			model,
			targetThinking ?? session.routedModel?.thinkingLevel ?? session.thinkingLevel,
		);
		const failureKey = JSON.stringify([session.sessionManager.getSessionId(), model?.provider, model?.id]);
		const limit = this._autoCompactionLimit.check(failureKey, reason);
		if (limit === "quiet") return false;
		if (limit === "notice") {
			const errorMessage =
				"Automatic compaction stopped after three consecutive failures. Resolve the error and run /compact, or start a new session.";
			this.host.emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage,
			});
			// An overflow's failed reply is already out of the context: extensions hear that it was not recovered. The run
			// keeps the failure the provider reported for it.
			if (reason === "overflow") {
				await this.emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
			}
			return false;
		}
		let abortController: AbortController | undefined;
		let started = false;
		const outcome = { fromExtension: false, cancelledByExtension: false };
		this.host.run.windowUnfit = undefined;

		try {
			if (!model) {
				if (willRetry) await this._recoveryNotStarted("no model is selected");
				return false;
			}

			const pathEntries = session.sessionManager.getBranch();
			// The plan made ahead of the threshold, when it still holds: its summary is ready or already being written.
			const forced = this.host.forcedSystemPrompt();
			const planned =
				reason === "threshold"
					? this._prewarm.take(pathEntries, session.sessionManager.getSessionId(), model, settings, forced)
					: undefined;
			if (!planned) this._prewarm.drop();
			const preparation = planned ?? prepareCompaction(pathEntries, settings);
			if (!preparation) {
				if (willRetry) await this._recoveryNotStarted("nothing in the context can be summarized");
				return false;
			}
			this.host.cacheWarmer?.cancel();

			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			started = true;
			this.host.emit({ type: "compaction_start", reason });
			abortController.signal.throwIfAborted();

			const signal = abortController.signal;
			const result = await runCompaction(this._compactionHost(), {
				reason,
				willRetry,
				model,
				contextWindow: model.contextWindow,
				reserveTokens: settings.reserveTokens,
				preparation,
				branchEntries: pathEntries,
				signal,
				checkAbort: () => signal.throwIfAborted(),
				outcome,
			});
			this._autoCompactionLimit.succeeded();
			this._prewarm.reset();
			const stoppedAfterCompaction = abortController.signal.aborted || this.host.run.agentRunAbortRequested;
			this.host.emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry: willRetry && !stoppedAfterCompaction,
			});

			if (stoppedAfterCompaction) return false;
			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return session.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			this._prewarm.drop();
			if (error instanceof CompactionFitError) this.host.run.windowUnfit = message;
			const aborted = abortController?.signal.aborted === true || outcome.cancelledByExtension;
			if (!aborted && started) this._autoCompactionLimit.failed();
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				if (errorMessage && reason === "overflow") recordRunFailure(this.host.run.outcome, errorMessage);
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
				await this.emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension: outcome.fromExtension,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this.host.resolveIdleWaitIfIdle();
		}
	}
}
