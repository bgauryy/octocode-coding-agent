import { planConstraintActive } from "../plan-state.ts";
/**
 * One agent run of a session, from its starting messages to `agent_settled`: preparation and
 * `before_agent_start`, the post-run loop of retries, compaction and boundaries, interruption and
 * abort.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import type { CacheWarmer } from "../cache-warmer.ts";
import { withRunInputOrigin } from "../input-origin.ts";
import type { AgentInterruptedEvent } from "../features/types.ts";
import type { BeforeAgentStartTrigger } from "../features/runner.ts";
import type { SessionBash } from "./bash.ts";
import type { SessionBoundaries } from "./boundaries.ts";
import { settleSessionDispatch } from "./dispatch.ts";
import type { AbortReason, SessionInternals } from "./host.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import { findLastAssistantMessage } from "./messages.ts";
import type { SessionModelControl } from "./model-control.ts";
import { normalizePromptImages } from "./prompt-expansion.ts";
import { startQueuedInput } from "./queued-start.ts";
import { assertImageInputSupported } from "@octocodeai/octocode-ai/utils/image-input";
import type { SessionRetry } from "./retry.ts";
import { SessionFallback } from "./retry-fallback.ts";
import { createRunOutcome, recordRunFailure, recordRunWarning, settledRunOutcome } from "./run-outcome.ts";
import type { SessionToolLoadout } from "./tool-loadout.ts";
import type { PendingUserInput } from "./types.ts";

export interface RunLoopHost extends Pick<
	SessionInternals,
	"session" | "run" | "cwd" | "emit" | "resolveIdleWaitIfIdle"
> {
	readonly inputs: SessionInputQueue;
	readonly tools: SessionToolLoadout;
	readonly retry: SessionRetry;
	readonly models: SessionModelControl;
	readonly bash: SessionBash;
	readonly boundaries: SessionBoundaries;
	readonly cacheWarmer: Pick<CacheWarmer, "onAgentSettled"> | undefined;
	/** The session's `_prepareRun`. */
	prepareRun(trigger: BeforeAgentStartTrigger, input?: PendingUserInput): Promise<AgentMessage[]>;
	/** The session's `_checkCompaction`. */
	checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		incoming?: readonly AgentMessage[],
	): Promise<boolean>;
	waitForIdle(): Promise<void>;
}

/** The message a run is about to append, as far as the pre-prompt compaction check can size it before features edit it. */
function incomingMessages(trigger: BeforeAgentStartTrigger): AgentMessage[] {
	if (trigger.messageType === "custom") return [trigger.message];
	return [{ role: "user", content: [{ type: "text", text: trigger.prompt }, ...(trigger.images ?? [])], timestamp: 0 }];
}

export class SessionRunLoop {
	private _abortReason?: AbortReason;
	/** Replaced or shut down (only teardown aborts so): the interface carries its queues over; no run starts from them. */
	private _retiring = false;
	private _pendingInterruption?: AgentInterruptedEvent;
	private readonly _interruptionCallback = new AsyncLocalStorage<{ active: boolean }>();

	private readonly host: RunLoopHost;
	private readonly fallback: SessionFallback;

	constructor(host: RunLoopHost) {
		this.host = host;
		this.fallback = new SessionFallback({
			session: host.session,
			run: host.run,
			emit: (event) => host.emit(event),
			models: host.models,
			omitRecoveryAttempt: (message) => host.boundaries.omitRecoveryAttempt(message),
			isRetryable: (message) => host.retry.isRetryableError(message),
		});
	}

	/**
	 * Start a run from a user or custom message. The session counts as busy from here on, so
	 * messages sent while before_agent_start handlers run are queued into this run instead of
	 * starting another. Cancellation during preparation prevents the first provider request.
	 * @param onStarted Called once the run's messages are prepared, before the first request.
	 */
	startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void, input?: PendingUserInput): Promise<void> {
		// The run's own origin scope: input queued into it from another client moves only this run's origin.
		return withRunInputOrigin(() => this._startRun(trigger, onStarted, input));
	}

	private async _startRun(
		trigger: BeforeAgentStartTrigger,
		onStarted?: () => void,
		input?: PendingUserInput,
	): Promise<void> {
		const { session, run, inputs, bash } = this.host;
		// A second run would reset the active run's state and, on failing, settle the session while that run still streams.
		if (run.active)
			throw new Error("A run is already active in this session. Queue the message with steer or followUp.");
		if (
			planConstraintActive(session.sessionManager) &&
			!session.featureHost
				.getRegisteredCommands()
				.some((command) => command.name === "plan" && command.sourceInfo.owner === "native")
		)
			throw new Error("This session has an active planning constraint. Enable native features before continuing.");
		run.logicalTurnId = randomUUID();
		run.outcome = createRunOutcome();
		run.hasRun = true;
		this._abortReason = undefined;
		this._pendingInterruption = undefined;
		run.inputTerminated = false;
		run.active = true;
		run.agentRunAbortRequested = false;
		run.featureRunAbortRequested = false;
		let messages: AgentMessage[];
		try {
			messages = await this.host.prepareRun(trigger, input);
		} catch (error) {
			// The preparation failure is what the caller needs to hear; a failed flush must not keep the session busy.
			recordRunFailure(run.outcome, errorMessage(error));
			this._flushHeld();
			try {
				await this._emitInterruption();
			} finally {
				run.active = false;
				run.logicalTurnId = undefined;
				this.host.resolveIdleWaitIfIdle();
			}
			throw error;
		}
		// The body's first failure is rethrown only after the run settles: every wait on this session ends there, so
		// nothing that can throw (a held message meeting a full disk, a lost lock) may stand between a run and settling.
		let failure: { error: unknown } | undefined;
		try {
			// Messages held while the run was starting go before its starting messages, as they would
			// have while idle. No run exists yet, so they cannot split a tool call from its result.
			bash.flushPending();
			inputs.flushPendingCustomMessages();
			onStarted?.();

			// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
			run.failedResponse = undefined;
			this.host.models.recordSelection();
			// The run records the loadout in the transcript; restored tools that did not register by now
			// are dropped, so a tool that never registers does not stay pending. MCP tools of servers that
			// are still connecting stay pending until their server registers them or settles.
			this.host.tools.settlePendingToolNames();
			if (!run.agentRunAbortRequested) {
				await session.agent.prompt(messages);
				while (!run.agentRunAbortRequested && !run.inputTerminated) {
					if (await this._handlePostAgentRun()) {
						if (run.agentRunAbortRequested) break;
						// The run's turns are over, so held messages (such as those sent after an overflow compaction) cannot split a
						// tool call from its result; append them before the retry's first request rather than after its turn.
						inputs.flushDuringRun(run.outcome);
						await session.agent.continue();
						continue;
					}
					if (run.agentRunAbortRequested || !(await this.host.boundaries.runBeforeSettle())) break;
					if (run.agentRunAbortRequested) break;
					await session.agent.continue();
				}
			}
		} catch (error) {
			failure = { error };
			recordRunFailure(run.outcome, errorMessage(error));
		}
		if (run.agentRunAbortRequested) this.host.retry.finishCancelled();
		// A series no reply closed ends with its run: the next run's first failure starts a series of its own.
		else this.host.retry.finishUnresolved(failure ? errorMessage(failure.error) : undefined);
		run.failedResponse = undefined;
		this.host.tools.runSystemPromptOptions = undefined;
		// A run that worked stays a success: what could not be written stays queued for the next write, and a reply already
		// produced must not be lost to a lock another process held for a moment.
		const flushFailure = this._flushHeld();
		if (flushFailure) recordRunWarning(run.outcome, errorMessage(flushFailure.error));
		try {
			await this._emitInterruption();
		} catch (error) {
			failure ??= { error };
		}
		// Input queued after the run's last delivery point would wait for an unrelated prompt and land after it: unless the
		// run failed or was stopped for its replacement, shutdown or an internal step (which delivers what waits itself),
		// it starts a run as this one settles.
		const drainQueue =
			!failure &&
			!this._retiring &&
			!(run.agentRunAbortRequested && ["internal", "shutdown", "replacement"].includes(this._abortReason ?? ""));
		try {
			await settleSessionDispatch(session, () => this._emitAgentSettled(drainQueue));
		} catch (error) {
			failure ??= { error };
		} finally {
			run.logicalTurnId = undefined;
		}
		if (failure) throw failure.error;
	}

	/** Appends the messages held for the end of a run, and returns a failure instead of throwing it. */
	private _flushHeld(): { error: unknown } | undefined {
		let failure: { error: unknown } | undefined;
		for (const flush of [() => this.host.bash.flushPending(), () => this.host.inputs.flushPendingCustomMessages()]) {
			try {
				flush();
			} catch (error) {
				failure ??= { error };
			}
		}
		return failure;
	}

	/**
	 * Prepare a run and return its starting messages: compact first when needed, emit
	 * before_agent_start, apply the run's prompt options and tool loadout, and build the starting
	 * message followed by pending nextTurn messages (consumed here) and handler messages, with a
	 * system patch first when the prompt changed.
	 */
	async prepareRun(trigger: BeforeAgentStartTrigger, input?: PendingUserInput): Promise<AgentMessage[]> {
		const { session, tools } = this.host;
		// Check if we need to compact before sending (catches aborted responses).
		// The starting message is sent below, so do not call agent.continue() here.
		const lastAssistant = findLastAssistantMessage(session.agent.state.messages);
		if (lastAssistant) {
			await this.host.checkCompaction(lastAssistant, false, incomingMessages(trigger));
		}

		const selectedToolsBefore = tools.baseSystemPromptOptions.selectedTools;
		const result = await session.featureHost.emitBeforeAgentStart(trigger, tools.baseSystemPromptOptions);
		// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
		// which updates the live loadout instead. An explicit edit wins; otherwise the live
		// loadout is authoritative, so a setActiveTools() call is not undone here.
		const handlerEditedTools =
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = session.getActiveToolNames();

		const messages: AgentMessage[] = [];
		if (trigger.messageType === "custom") {
			messages.push(trigger.message);
		} else {
			// Normalize images after before_agent_start so feature-driven model selection
			// determines the resize profile used for the request and history.
			assertImageInputSupported(session.model, trigger.images ?? []);
			const normalized = await normalizePromptImages(
				session.settingsManager,
				this.host.models.limitsModel(),
				trigger.images,
			);
			const text = normalized.hints.length > 0 ? `${trigger.prompt}\n\n${normalized.hints.join("\n")}` : trigger.prompt;
			messages.push({
				role: "user",
				content: [{ type: "text", text }, ...normalized.images],
				timestamp: Date.now(),
			});
		}
		if (input && trigger.messageType === "user") this.host.inputs.setUserInput(messages[messages.length - 1], input);
		// Inject any pending "nextTurn" messages as context alongside the starting message
		messages.push(...this.host.inputs.takeNextTurnMessages());
		for (const msg of result.messages) {
			messages.push({
				role: "custom",
				customType: msg.customType,
				// Untyped features can pass null/missing content; normalize at ingestion.
				content: msg.content ?? [],
				display: msg.display,
				details: msg.details,
				timestamp: Date.now(),
			});
		}
		const updateMessage = tools.preparePromptAndToolLoadout(result.systemPromptOptions);
		tools.runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);
		return messages;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const { session, run, retry } = this.host;
		const message = run.lastAssistantMessage;
		run.lastAssistantMessage = undefined;
		if (run.agentRunAbortRequested) {
			retry.finishCancelled();
			return false;
		}
		if (!message) return session.agent.hasQueuedMessages();

		if (retry.isRetryableError(message)) {
			const decision = await retry.prepare(message);
			// A cancelled wait stops the run: no fallback model, compaction resume or queued continuation follows it.
			if (decision === "cancelled") run.agentRunAbortRequested = true;
			if (decision === "retry" && !run.agentRunAbortRequested) {
				run.failedResponse = message;
				return true;
			}
		}
		if (run.agentRunAbortRequested) {
			retry.finishCancelled();
			return false;
		}
		// A backoff series that ends here failed, also when a fallback model takes over: it starts its own series.
		if (message.stopReason === "error" && retry.attempt > 0) {
			retry.finishFailed(message);
		}
		if (await this.fallback.prepare(message)) return true;

		if (await this.host.checkCompaction(message, true)) {
			return !run.agentRunAbortRequested;
		}

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !run.agentRunAbortRequested && session.agent.hasQueuedMessages();
	}

	private async _emitAgentSettled(drainQueue: boolean): Promise<void> {
		const { session, run } = this.host;
		this.host.cacheWarmer?.onAgentSettled();
		run.active = false;
		run.isEmittingAgentSettled = true;
		try {
			const aborted = run.agentRunAbortRequested;
			const outcome = settledRunOutcome(run.outcome, aborted);
			run.outcome = outcome;
			await session.featureHost.emit({ type: "agent_settled", aborted, outcome });
			this.host.emit({ type: "agent_settled", aborted, outcome });
		} finally {
			run.isEmittingAgentSettled = false;
		}

		// Sends made by agent_settled handlers run now; agent_settle_end tells features they have, so a wake whose send
		// started no run stops counting without a timer.
		const deferred = run.deferredSettledActions.splice(0);
		try {
			for (const action of deferred) await action();
			if (drainQueue && !run.active && !session.isCompacting)
				await startQueuedInput({
					session,
					inputs: this.host.inputs,
					startRun: (trigger, onStarted, input) => this.startRun(trigger, onStarted, input),
				});
		} finally {
			await session.featureHost.emit({ type: "agent_settle_end" });
			this.host.resolveIdleWaitIfIdle();
		}
	}

	get retiring(): boolean {
		return this._retiring;
	}

	recordAbortReason(reason: AbortReason): void {
		const { session, run } = this.host;
		if (!run.active || !run.logicalTurnId || this._abortReason) return;
		this._abortReason = reason;
		if (reason === "interrupted" || reason === "peer" || reason === "replacement")
			session.sessionManager.appendCustomEntry("octocode-interrupt", { reason, at: new Date().toISOString() });
		if (reason === "interrupted" || reason === "peer")
			this._pendingInterruption = {
				type: "agent_interrupted",
				turnId: run.logicalTurnId,
				sessionId: session.sessionManager.getSessionId(),
				transcriptPath: session.sessionManager.getSessionFile(),
				cwd: this.host.cwd,
				model: session.model ? { ...session.model } : undefined,
			};
	}

	private async _emitInterruption(): Promise<void> {
		const event = this._pendingInterruption;
		this._pendingInterruption = undefined;
		if (event) {
			const callback = { active: true };
			try {
				await this._interruptionCallback.run(callback, () => this.host.session.featureHost.emit(event));
			} finally {
				callback.active = false;
			}
		}
	}

	async abort(reason: AbortReason): Promise<void> {
		const { session, run } = this.host;
		if (reason === "replacement" || reason === "shutdown") this._retiring = true;
		this.recordAbortReason(reason);
		if (run.active) {
			run.agentRunAbortRequested = true;
		}
		session.abortRetry();
		// Only the user's Stop cancels a running compaction: a peer's interrupt waits behind it.
		if (reason !== "peer") session.abortCompaction();
		session.abortBranchSummary();
		if (run.isBeforeSettle) run.beforeSettleAbort.abort();
		session.agent.abort();
		if (!this._interruptionCallback.getStore()?.active) await this.host.waitForIdle();
	}
}
