/**
 * One agent run of a session, from its starting messages to `agent_settled`: preparation and
 * `before_agent_start`, the post-run loop of retries, compaction and boundaries, interruption and
 * abort.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import type { CacheWarmer } from "../cache-warmer.ts";
import type { AgentInterruptedEvent } from "../extensions/types.ts";
import type { BeforeAgentStartTrigger } from "../extensions/runner.ts";
import type { SessionBash } from "./bash.ts";
import type { SessionBoundaries } from "./boundaries.ts";
import type { AbortReason, SessionInternals } from "./host.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import { findLastAssistantMessage } from "./messages.ts";
import type { SessionModelControl } from "./model-control.ts";
import { normalizePromptImages } from "./prompt-expansion.ts";
import type { SessionRetry } from "./retry.ts";
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
		toolResults?: AgentMessage[],
	): Promise<boolean>;
	waitForIdle(): Promise<void>;
}

export class SessionRunLoop {
	private _abortReason?: AbortReason;
	private _pendingInterruption?: AgentInterruptedEvent;
	private readonly _interruptionCallback = new AsyncLocalStorage<{ active: boolean }>();

	private readonly host: RunLoopHost;

	constructor(host: RunLoopHost) {
		this.host = host;
	}

	/**
	 * Start a run from a user or custom message. The session counts as busy from here on, so
	 * messages sent while before_agent_start handlers run are queued into this run instead of
	 * starting another, and an abort requested meanwhile aborts the run as soon as it exists.
	 * @param onStarted Called once the run's messages are prepared, before the first request.
	 */
	async startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void, input?: PendingUserInput): Promise<void> {
		const { session, run, inputs, bash } = this.host;
		run.logicalTurnId = randomUUID();
		this._abortReason = undefined;
		this._pendingInterruption = undefined;
		run.inputTerminated = false;
		run.active = true;
		run.agentRunAbortRequested = false;
		run.extensionRunAbortRequested = false;
		let messages: AgentMessage[];
		try {
			messages = await this.host.prepareRun(trigger, input);
		} catch (error) {
			bash.flushPending();
			inputs.flushPendingCustomMessages();
			await this._emitInterruption();
			run.active = false;
			run.logicalTurnId = undefined;
			this.host.resolveIdleWaitIfIdle();
			throw error;
		}
		// Messages held while the run was starting go before its starting messages, as they would
		// have while idle. No run exists yet, so they cannot split a tool call from its result.
		bash.flushPending();
		inputs.flushPendingCustomMessages();
		onStarted?.();

		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		run.failedResponse = undefined;
		this.host.models.recordSelection();
		// The run records the loadout in the transcript; restored tools that did not register by now
		// are dropped, so a tool that never registers does not stay pending.
		this.host.tools.clearPendingToolNames();
		try {
			await session.agent.prompt(messages);
			while (!run.agentRunAbortRequested && !run.inputTerminated) {
				if (await this._handlePostAgentRun()) {
					if (run.agentRunAbortRequested) break;
					await session.agent.continue();
					continue;
				}
				if (run.agentRunAbortRequested || !(await this.host.boundaries.runBeforeSettle())) break;
				if (run.agentRunAbortRequested) break;
				await session.agent.continue();
			}
		} finally {
			if (run.agentRunAbortRequested) this.host.retry.finishCancelled();
			run.failedResponse = undefined;
			this.host.tools.runSystemPromptOptions = undefined;
			bash.flushPending();
			inputs.flushPendingCustomMessages();
			try {
				await this._emitInterruption();
				await this._emitAgentSettled();
			} finally {
				run.logicalTurnId = undefined;
			}
		}
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
			await this.host.checkCompaction(lastAssistant, false);
		}

		const selectedToolsBefore = tools.baseSystemPromptOptions.selectedTools;
		const result = await session.extensionRunner.emitBeforeAgentStart(trigger, tools.baseSystemPromptOptions);
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
			// Normalize images after before_agent_start so extension-driven model selection
			// determines the resize profile used for the request and history.
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
				// Untyped extensions can pass null/missing content; normalize at ingestion.
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
		const toolResults = run.lastAssistantToolResults;
		run.lastAssistantMessage = undefined;
		run.lastAssistantToolResults = [];
		if (run.agentRunAbortRequested) {
			retry.finishCancelled();
			return false;
		}
		if (!message) return session.agent.hasQueuedMessages();

		if (retry.isRetryableError(message) && (await retry.prepare(message))) {
			if (run.agentRunAbortRequested) retry.finishCancelled();
			run.failedResponse = message;
			return !run.agentRunAbortRequested;
		}
		if (run.agentRunAbortRequested) {
			retry.finishCancelled();
			return false;
		}

		if (message.stopReason === "error" && retry.attempt > 0) {
			retry.finishFailed(message);
		}

		if (await this.host.checkCompaction(message, true, toolResults)) {
			return !run.agentRunAbortRequested;
		}

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !run.agentRunAbortRequested && session.agent.hasQueuedMessages();
	}

	private async _emitAgentSettled(): Promise<void> {
		const { session, run } = this.host;
		this.host.cacheWarmer?.onAgentSettled();
		run.active = false;
		run.isEmittingAgentSettled = true;
		try {
			const aborted = run.agentRunAbortRequested;
			await session.extensionRunner.emit({ type: "agent_settled", aborted });
			this.host.emit({ type: "agent_settled", aborted });
		} finally {
			run.isEmittingAgentSettled = false;
		}

		const deferred = run.deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this.host.resolveIdleWaitIfIdle();
			}
			return;
		}
		this.host.resolveIdleWaitIfIdle();
	}

	recordAbortReason(reason: AbortReason): void {
		const { session, run } = this.host;
		if (!run.active || !run.logicalTurnId || this._abortReason) return;
		this._abortReason = reason;
		if (reason === "interrupted")
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
				await this._interruptionCallback.run(callback, () => this.host.session.extensionRunner.emit(event));
			} finally {
				callback.active = false;
			}
		}
	}

	async abort(reason: AbortReason): Promise<void> {
		const { session, run } = this.host;
		this.recordAbortReason(reason);
		if (run.active) {
			run.agentRunAbortRequested = true;
		}
		session.abortRetry();
		session.abortCompaction();
		session.abortBranchSummary();
		if (run.isBeforeSettle) run.abortDuringBeforeSettle = true;
		session.agent.abort();
		if (!this._interruptionCallback.getStore()?.active) await this.host.waitForIdle();
	}
}
