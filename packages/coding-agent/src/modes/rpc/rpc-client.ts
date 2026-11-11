import type { PlanOptions, PlanState } from "../../core/plan-state.ts";
/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import type { AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { ImageContent } from "@octocodeai/octocode-ai";
import type { PromptDisposition, QueuedInputDisposition, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import { RpcConnection } from "./rpc-client/connection.ts";
import { promptAndCollect } from "./rpc-client/prompt.ts";
import { createQueueClient } from "./rpc-client/queue.ts";
import type { ModelInfo, RpcClientOptions, RpcCommandBody, RpcEvent, RpcEventListener } from "./rpc-client/types.ts";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

export type { ModelInfo, RpcClientOptions, RpcEvent, RpcEventListener } from "./rpc-client/types.ts";

export class RpcClient {
	private connection: RpcConnection;
	/** List, edit, remove and move queued messages by queue id. */
	readonly queue = createQueueClient(async (command) => this.getData(await this.send(command)));

	constructor(options: RpcClientOptions = {}) {
		this.connection = new RpcConnection(options);
	}

	/**
	 * Start the RPC agent process. Resolves once the session announces itself with `rpc_ready`; rejects when the process
	 * exits, fails to start or is stopped first.
	 */
	async start(): Promise<void> {
		await this.connection.start();
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		await this.connection.stop();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		return this.connection.onEvent(listener);
	}

	/** Observe process failure or stop once per run; a closed run immediately reports its error. */
	onClose(listener: (error: Error) => void): () => void {
		return this.connection.onClose(listener);
	}

	/** Subscribe to UI requests separately from session events. */
	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		return this.connection.onExtensionUIRequest(listener);
	}

	/** Reply using the request's id. UI replies have no RPC acknowledgement. */
	async respondToExtensionUIRequest(response: RpcExtensionUIResponse): Promise<void> {
		await this.connection.respondToExtensionUIRequest(response);
	}

	getStderr(): string {
		return this.connection.getStderr();
	}

	/**
	 * Send a prompt to the agent.
	 * Returns acceptance unless waitForCompletion also waits for extension-dispatched work.
	 * A handled prompt may have started other work; use onEvent() for streaming events.
	 */
	async prompt(
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
		options?: { waitForCompletion?: boolean; dispatchId?: string },
	): Promise<PromptDisposition> {
		const response = await this.send(
			{ type: "prompt", message, images, streamingBehavior, ...options },
			options?.waitForCompletion ? null : undefined,
		);
		return this.getData<{ disposition: PromptDisposition }>(response).disposition;
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.send({ type: "steer", message, images });
		return this.getData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.send({ type: "follow_up", message, images });
		return this.getData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Clear queued steering and follow-up messages, returning their text.
	 */
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const response = await this.send({ type: "clear_queue" });
		return this.getData(response);
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/** Persist a new session before its first prompt. */
	async persistSession(): Promise<void> {
		await this.send({ type: "persist_session" });
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Get list of available thinking levels for the current model.
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/** Control native planning and read its revision. */
	async plan(options: PlanOptions): Promise<PlanState> {
		const response = await this.send({ type: "plan", ...options });
		return this.getData(response);
	}

	async compact(options?: { customInstructions?: string }): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", ...options }, null);
		return this.getData(response);
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command }, null);
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get session entries in append order, optionally only those after the `since` entry id.
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * Get the session entry tree.
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// Helpers
	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_settled event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return this.connection.waitForIdle(timeout);
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<RpcEvent[]> {
		return this.connection.collectEvents(timeout);
	}

	/**
	 * Collect events through dispatched work completion. A timeout stops waiting, without aborting or replaying work.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<RpcEvent[]> {
		return promptAndCollect(this.connection, message, images, timeout);
	}

	// Internal

	/**
	 * Send a command and wait for its response. `timeoutMs` bounds short requests; commands that answer only after their
	 * work finishes (compact, bash) pass `null` and wait, since the process exiting still rejects them.
	 */
	private send(command: RpcCommandBody, timeoutMs?: number | null): Promise<RpcResponse> {
		return this.connection.send(command, timeoutMs);
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response;
			const { execution, authRequired } = errorResponse;
			throw Object.assign(new Error(errorResponse.error), { execution, ...(authRequired ? { authRequired } : {}) });
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
