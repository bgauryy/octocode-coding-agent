import type { ManualCompactionOptions } from "../compaction/manual-options.ts";
/** Public `AgentSession` members that start, queue, interrupt and compact agent runs, and run bash. */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import type { BashResult } from "../bash-executor.ts";
import type { UserBashOptions } from "./user-bash.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type { CustomMessage } from "../messages.ts";
import type { BashOperations } from "../tools/bash.ts";
import type {
	PromptOptions,
	QueuedInput,
	QueuedInputDisposition,
	QueuedInputOptions,
	ReleasedQueuedInput,
} from "./types.ts";

export interface AgentSessionPromptingApi {
	/**
	 * Send a prompt to the agent.
	 * - Handles feature commands (registered via api.commands.register) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	prompt(text: string, options?: PromptOptions): Promise<void>;

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on feature commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source (defaults to interactive) and whether to attach image paths the text names
	 * @throws Error if text is a feature command
	 */
	steer(text: string, images?: ImageContent[], options?: QueuedInputOptions): Promise<QueuedInputDisposition>;

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on feature commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source (defaults to interactive) and whether to attach image paths the text names
	 * @throws Error if text is a feature command
	 */
	followUp(text: string, images?: ImageContent[], options?: QueuedInputOptions): Promise<QueuedInputDisposition>;

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			/** With `followUp`: drain together with the neighbouring follow-ups that set it too, so several reports cost one turn. */
			together?: boolean;
		},
	): Promise<void>;

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch feature commands and expand skill commands and prompt templates. Default: false.
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: {
			deliverAs?: "steer" | "followUp";
			expandPromptTemplates?: boolean;
		},
	): Promise<void>;

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] };

	/** Number of pending messages (includes both steering and follow-up) */
	readonly pendingMessageCount: number;

	/** Whether a custom message sent with this exact `details` object (identity, not equality) still waits in the agent's queue. */
	isCustomMessageQueued(details: object): boolean;

	/** Rewrites a custom message sent with this exact `details` object while it waits; false once it was read. */
	replaceQueuedCustomMessage(details: object, content: string): boolean;

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[];

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[];

	/** Queued messages in delivery order (steering first, then follow-ups), each with an id for the edit methods. */
	getQueuedInputs(): readonly QueuedInput[];

	/**
	 * Replace the text of a queued message, keeping its attachments, kind and position. Empty or whitespace-only text
	 * removes it. "missing" means it is no longer queued, for example because its delivery has begun.
	 */
	replaceQueuedInput(id: string, text: string): "replaced" | "removed" | "missing";

	/** Remove one queued message so it is never delivered; undefined when it is no longer queued. */
	removeQueuedInput(id: string): QueuedInput | undefined;

	/** Move a queued message one place earlier or later among messages of its kind; false when it cannot move. */
	moveQueuedInput(id: string, direction: "up" | "down"): boolean;

	/** Make a queued message wait for the next turn (`steer`) or until the run ends (`followUp`); it goes last among that kind. */
	setQueuedInputMode(id: string, mode: "steer" | "followUp"): boolean;

	/**
	 * Take a queued message out of delivery while the user edits it, keeping its place, kind and attachments; it is
	 * still listed with `held`. Undefined when it is no longer queued (its delivery has begun) or already held.
	 */
	holdQueuedInput(id: string): QueuedInput | undefined;

	/**
	 * Put a held message back in its place, with new text when given (blank text removes it). With no run active it
	 * leaves the queue instead ("idle") and the caller sends it; "missing" when the queue was cleared meanwhile.
	 */
	releaseQueuedInput(id: string, text?: string): ReleasedQueuedInput;

	/**
	 * Abort the current operation; internal cancellation and replacement do not emit interruption hooks. A user Stop
	 * (`"interrupted"`, the default) also clears the steering and follow-up queues; take them first with `clearQueue()`
	 * to give the text back to its user.
	 */
	abort(reason?: "interrupted" | "peer" | "replacement" | "shutdown" | "internal"): Promise<void>;

	waitForIdle(): Promise<void>;

	/** Resolves once the run and what it left behind are done: a compaction a feature asked for as it settled and the turn resuming from it. */
	settled(): Promise<void>;
}

/** Compaction, auto-retry and bash execution of `AgentSession`. */
export interface AgentSessionRecoveryApi {
	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and features. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 */
	compact(options?: ManualCompactionOptions): Promise<CompactionResult>;

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void;

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void;

	readonly autoCompactionEnabled: boolean;

	/** Cancel the retry wait in progress, which ends the run like a Stop: no fallback model, compaction or queued input follows. */
	abortRetry(): void;

	/** Whether auto-retry is currently in progress */
	readonly isRetrying: boolean;

	readonly autoRetryEnabled: boolean;

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void;

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			id?: string;
			operations?: BashOperations;
		},
	): Promise<BashResult>;

	/**
	 * Run a user `!`/`!!` command as every mode does: `user_bash` handlers may run it or supply its operations, else it
	 * runs here. Fails closed: a failing handler is reported as a feature error, nothing runs, and the promise rejects
	 * with a `UserBashHookError`. `onStart` fires just before the command runs here, not for a handler's result.
	 */
	runUserBash(command: string, options?: UserBashOptions): Promise<BashResult>;

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by features that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void;

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void;

	/** Whether a bash command is currently running */
	readonly isBashRunning: boolean;

	/** Whether there are pending bash messages waiting to be flushed */
	readonly hasPendingBashMessages: boolean;
}
