import { type ManualCompactionOptions, validateCompactionInstructions } from "../compaction/manual-options.ts";
/**
 * Manual and automatic compaction of a session: their abort controllers, events and failure
 * accounting around the shared compaction core (`session-compaction.ts`), and Octocode's default summary.
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { type Model, type RetryCallbacks, streamSimple } from "@octocodeai/octocode-ai/compat";
import { formatNoModelSelectedMessage } from "../auth-guidance.ts";
import type { CacheWarmer } from "../cache-warmer.ts";
import { type CompactionPreparation, type CompactionResult, compact, prepareCompaction } from "../compaction/index.ts";
import type { SessionCompactFailedEvent } from "../extensions/index.ts";
import { type CompactionHost, type CompactionReason, runCompaction } from "../session-compaction.ts";
import { createSessionUsageRecorder } from "../usage-totals.ts";
import type { SessionInternals, SessionPublic } from "./host.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { AgentSessionEvent } from "./types.ts";

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

/** What Octocode's default compaction summary needs; the session passes itself or a test double. */
export interface DefaultCompactionHost {
	readonly session: Pick<SessionPublic, "sessionManager" | "settingsManager" | "agent">;
	emit(event: AgentSessionEvent): void;
	getSummarizationRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<RequestAuth & { thinkingLevel: ThinkingLevel }>;
	summarizationRetryCallbacks(source: { source: "compaction"; reason: CompactionReason }): RetryCallbacks;
}

/** Generate Octocode's built-in compaction summary for manual and automatic compaction. */
export async function runDefaultCompaction(
	host: DefaultCompactionHost,
	preparation: CompactionPreparation,
	model: Model<any>,
	signal: AbortSignal,
	reason: CompactionReason,
	customInstructions?: string,
): Promise<CompactionResult> {
	const { session } = host;
	// Resolve the request only when Octocode summarizes itself: routing may call models or fail.
	const record = createSessionUsageRecorder(session.sessionManager, "compaction_attempt", (entry) =>
		host.emit({ type: "entry_appended", entry }),
	);
	const request = await host.getSummarizationRequestAuth(model, signal);
	const streamFn = session.agent.streamFunction ?? streamSimple;
	const result = await compact(
		preparation,
		request.model,
		request.apiKey,
		request.headers,
		customInstructions,
		signal,
		request.thinkingLevel,
		async (model, context, options) => {
			const stream = await streamFn(model, context, options);
			const result = stream.result.bind(stream);
			stream.result = async () => {
				const message = await result();
				record(message);
				return message;
			};
			return stream;
		},
		request.env,
		session.settingsManager.getRetrySettings(),
		host.summarizationRetryCallbacks({ source: "compaction", reason }),
		undefined, // sessionId
	);
	return { ...result, usage: undefined };
}

export interface CompactionControlHost extends Pick<
	SessionInternals,
	"session" | "run" | "emit" | "refreshContext" | "resolveIdleWaitIfIdle"
> {
	readonly cacheWarmer: Pick<CacheWarmer, "cancel"> | undefined;
	/** The session's default summary (`_runDefaultCompaction`). */
	summarize: CompactionHost["summarize"];
}

export class SessionCompaction {
	private _autoCompactionFailures = { key: "", count: 0 };
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
			throw pathEntries[pathEntries.length - 1]?.type === "compaction"
				? new NothingToCompactError("Already compacted", "Already compacted")
				: new NothingToCompactError("Nothing to compact (session too small)", "Nothing to compact yet");
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
			this._autoCompactionFailures = { key: "", count: 0 };
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
		return compactionResult;
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abort(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
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
		if (this._autoCompactionFailures.key !== failureKey) this._autoCompactionFailures = { key: failureKey, count: 0 };
		if (this._autoCompactionFailures.count >= 3) {
			this.host.emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					"Automatic compaction stopped after three consecutive failures. Resolve the error and run /compact, or start a new session.",
			});
			return false;
		}
		let abortController: AbortController | undefined;
		let started = false;
		const outcome = { fromExtension: false, cancelledByExtension: false };

		try {
			if (!model) {
				if (willRetry) await this._recoveryNotStarted("no model is selected");
				return false;
			}

			const pathEntries = session.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
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
			this._autoCompactionFailures.count = 0;
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
			const aborted = abortController?.signal.aborted === true || outcome.cancelledByExtension;
			if (!aborted && started) this._autoCompactionFailures.count += 1;
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
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
