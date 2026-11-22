/**
 * Run control of `AgentSession`: prompting and input queues, abort and idle waiting, compaction,
 * auto-retry and bash bookkeeping. Each member forwards to a collaborator under `./`; the members are
 * documented on `AgentSessionApi` (`./api.ts`). `AgentSession` extends this class and adds `executeBash`,
 * which needs the planning constraint from the `octocode/` feature layer that `core/agent-session/` may not import.
 */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type { ManualCompactionOptions } from "../compaction/manual-options.ts";
import type { CustomMessage } from "../messages.ts";
import { abortSessionDispatches, trackSessionDispatch } from "./dispatch.ts";
import type { AbortReason } from "./host.ts";
import { prompt, queueUserInput, releaseQueuedInput, sendCustomMessage } from "./prompting.ts";
import { splitUserContent } from "./queued-start.ts";
import { AgentSessionState } from "./session-state.ts";
import type {
	PromptOptions,
	QueuedInput,
	QueuedInputDisposition,
	QueuedInputOptions,
	ReleasedQueuedInput,
} from "./types.ts";

export abstract class AgentSessionControl extends AgentSessionState {
	// Prompting and input queues

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await trackSessionDispatch(
			this,
			() => prompt(this._c.prompting, text, options),
			(active, dispatchId) => this._listeners.emit({ type: "session_dispatch", active, dispatchId }),
		);
		// Input queued while this submission was under way waited for its run; when it started none, or the input came
		// after that run's end, nothing else delivers it.
		releaseQueuedInput(this._c.prompting);
	}
	async steer(text: string, images?: ImageContent[], options?: QueuedInputOptions): Promise<QueuedInputDisposition> {
		return queueUserInput(this._c.prompting, text, images, "steer", options);
	}
	async followUp(text: string, images?: ImageContent[], options?: QueuedInputOptions): Promise<QueuedInputDisposition> {
		return queueUserInput(this._c.prompting, text, images, "followUp", options);
	}
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; together?: boolean },
	): Promise<void> {
		const send = () => sendCustomMessage(this._c.prompting, message, options);
		if (options?.triggerTurn) {
			await trackSessionDispatch(this, send, (active, dispatchId) =>
				this._listeners.emit({ type: "session_dispatch", active, dispatchId }),
			);
			releaseQueuedInput(this._c.prompting);
		} else await send();
	}
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		const { text, images } = splitUserContent(content);
		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "feature",
		});
	}
	clearQueue(): { steering: string[]; followUp: string[] } {
		return this._c.inputs.clear();
	}
	get pendingMessageCount(): number {
		return this._c.inputs.pendingMessageCount;
	}
	isCustomMessageQueued(details: object): boolean {
		return this._c.inputs.isCustomMessageQueued(details);
	}
	replaceQueuedCustomMessage(details: object, content: string): boolean {
		return this._c.inputs.replaceQueuedCustomMessage(details, content);
	}
	getSteeringMessages(): readonly string[] {
		return this._c.inputs.steeringMessages;
	}
	getFollowUpMessages(): readonly string[] {
		return this._c.inputs.followUpMessages;
	}
	getQueuedInputs(): readonly QueuedInput[] {
		return this._c.inputs.queuedInputs;
	}
	replaceQueuedInput(id: string, text: string): "replaced" | "removed" | "missing" {
		return this._c.inputs.replace(id, text);
	}
	removeQueuedInput(id: string): QueuedInput | undefined {
		return this._c.inputs.remove(id);
	}
	moveQueuedInput(id: string, direction: "up" | "down"): boolean {
		return this._c.inputs.move(id, direction);
	}
	setQueuedInputMode(id: string, mode: "steer" | "followUp"): boolean {
		return this._c.inputs.setMode(id, mode);
	}
	holdQueuedInput(id: string): QueuedInput | undefined {
		return this._c.inputs.hold(id);
	}
	releaseQueuedInput(id: string, text?: string): ReleasedQueuedInput {
		return this._c.inputs.release(id, text);
	}
	/**
	 * The user's Stop ("interrupted", the default) withdraws all queued input first, so neither the run going down nor the
	 * next one delivers it. An interface that gives the input back takes it with `clearQueue()` in the same tick, before
	 * this call. Other reasons leave the queues to whoever stops the run (a peer's held mail, a compaction, a replacement).
	 */
	async abort(reason: AbortReason = "interrupted"): Promise<void> {
		if (reason === "interrupted" && (this._c.inputs.pendingMessageCount > 0 || this.agent.hasQueuedMessages()))
			this._c.inputs.clear();
		abortSessionDispatches(this);
		await this._c.runLoop.abort(reason);
	}
	async stopActiveWork(): Promise<void> {
		await Promise.all([this.abort(), this._c.bash.abortAndWait()]);
	}
	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._listeners.idleWait();
	}

	async settled(): Promise<void> {
		for (;;) {
			await Promise.all(this._run.settledWork);
			// A turn that work starts begins a macrotask later at the latest.
			await new Promise((resolve) => setImmediate(resolve));
			if (this._run.settledWork.size === 0 && this.isIdle) return;
			await this.waitForIdle();
		}
	}

	// Compaction, auto-retry and bash execution

	async compact(options?: ManualCompactionOptions): Promise<CompactionResult> {
		return this._c.compaction.compact(options);
	}
	abortCompaction(): void {
		this._c.compaction.abort();
	}
	abortBranchSummary(): void {
		this._c.tree.abort();
	}
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}
	abortRetry(): void {
		this._c.retry.abort();
	}
	get isRetrying(): boolean {
		return this._c.retry.isRetrying;
	}
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._c.bash.record(command, result, options);
	}
	abortBash(): void {
		this._c.bash.abort();
	}
	get isBashRunning(): boolean {
		return this._c.bash.isRunning;
	}
	get hasPendingBashMessages(): boolean {
		return this._c.bash.hasPendingMessages;
	}
}
