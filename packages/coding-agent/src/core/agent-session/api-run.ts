import type { ManualCompactionOptions } from "../compaction/manual-options.ts";
/** Public `AgentSession` members that start, queue, interrupt and compact agent runs, and run bash. */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type { InputSource } from "../extensions/index.ts";
import type { CustomMessage } from "../messages.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { PromptOptions, QueuedInput, QueuedInputDisposition } from "./types.ts";

/** Prompting and input queues of `AgentSession`. */
export interface AgentSessionPromptingApi {
	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via api.registerCommand) immediately, even during streaming
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
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	steer(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<QueuedInputDisposition>;

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	followUp(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<QueuedInputDisposition>;

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
		},
	): Promise<void>;

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
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

	/** Abort the current operation; internal cancellation and replacement do not emit interruption hooks. */
	abort(reason?: "interrupted" | "replacement" | "shutdown" | "internal"): Promise<void>;

	waitForIdle(): Promise<void>;
}

/** Compaction, auto-retry and bash execution of `AgentSession`. */
export interface AgentSessionRecoveryApi {
	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
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

	/** Whether auto-compaction is enabled */
	readonly autoCompactionEnabled: boolean;

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void;

	/** Whether auto-retry is currently in progress */
	readonly isRetrying: boolean;

	/** Whether auto-retry is enabled */
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
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
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
