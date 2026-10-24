/**
 * Messages waiting for the agent: queued steering and follow-up input with the metadata
 * `user_input` handlers receive, next-turn asides, and context-only custom messages held until the
 * current turn's tool results are in.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import type { CustomMessage } from "../messages.ts";
import type { SessionInternals } from "./host.ts";
import type { PendingUserInput, QueuedInput } from "./types.ts";

interface QueuedEntry {
	id: string;
	mode: "steer" | "followUp";
	text: string;
	message: Extract<AgentMessage, { role: "user" }>;
}

export class SessionInputQueue {
	// Selected batches retain metadata across clearQueue; removed queue objects are weakly held.
	private readonly _pendingUserInputs = new WeakMap<AgentMessage, PendingUserInput>();
	/** Messages in the agent's steering and follow-up queues, in queue order. Removed when delivery begins. */
	private _queued: QueuedEntry[] = [];
	private _nextQueuedId = 1;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	private readonly host: Pick<SessionInternals, "session" | "emit" | "refreshContext">;

	constructor(host: Pick<SessionInternals, "session" | "emit" | "refreshContext">) {
		this.host = host;
	}

	get steeringMessages(): readonly string[] {
		return this._texts("steer");
	}

	get followUpMessages(): readonly string[] {
		return this._texts("followUp");
	}

	/** Queued messages in delivery order: steering first, then follow-ups. */
	get queuedInputs(): readonly QueuedInput[] {
		return [...this._entries("steer"), ...this._entries("followUp")].map((entry) => ({
			id: entry.id,
			mode: entry.mode,
			text: entry.text,
			imageCount: Array.isArray(entry.message.content)
				? entry.message.content.filter((part) => part.type === "image").length
				: 0,
			source: this._pendingUserInputs.get(entry.message)?.source ?? "interactive",
		}));
	}

	private _entries(mode: "steer" | "followUp"): QueuedEntry[] {
		return this._queued.filter((entry) => entry.mode === mode);
	}

	private _texts(mode: "steer" | "followUp"): string[] {
		return this._entries(mode).map((entry) => entry.text);
	}

	get pendingCustomMessages(): readonly CustomMessage[] {
		return this._pendingCustomMessages;
	}

	/** The `user_input` metadata of a queued or starting message. */
	getUserInput(message: AgentMessage): PendingUserInput | undefined {
		return this._pendingUserInputs.get(message);
	}

	setUserInput(message: AgentMessage, input: PendingUserInput): void {
		this._pendingUserInputs.set(message, input);
	}

	deleteUserInput(message: AgentMessage): void {
		this._pendingUserInputs.delete(message);
	}

	private _emitQueueUpdate(): void {
		this.host.emit({
			type: "queue_update",
			steering: this._texts("steer"),
			followUp: this._texts("followUp"),
		});
	}

	/** Delivery of `message` begins: it leaves the queue and can no longer be edited. */
	consumeQueuedUserMessage(message: AgentMessage): void {
		const index = this._queued.findIndex((entry) => entry.message === message);
		if (index === -1) return;
		this._queued.splice(index, 1);
		this._emitQueueUpdate();
	}

	/**
	 * Replace the text of a queued message, keeping its attachments, position and kind. Empty or whitespace-only
	 * text removes it. "missing" means it is gone, usually because delivery had begun.
	 */
	replace(id: string, text: string): "replaced" | "removed" | "missing" {
		const entry = this._queued.find((candidate) => candidate.id === id);
		if (!entry || !this.host.session.agent.hasQueuedMessage(entry.message)) return "missing";
		if (!text.trim()) {
			return this.remove(id) ? "removed" : "missing";
		}
		const { message } = entry;
		const parts = Array.isArray(message.content) ? message.content : [];
		const attachments = parts.filter((part) => part.type !== "text");
		message.content = [{ type: "text", text }, ...attachments];
		entry.text = text;
		const input = this._pendingUserInputs.get(message);
		if (input) this._pendingUserInputs.set(message, { ...input, text, expandedPaths: undefined });
		this._emitQueueUpdate();
		return "replaced";
	}

	/** Take one message out of the queue so it is never delivered; undefined when it is no longer queued. */
	remove(id: string): QueuedInput | undefined {
		const queued = this.queuedInputs.find((candidate) => candidate.id === id);
		if (!queued) return undefined;
		const entry = this._queued.find((candidate) => candidate.id === id);
		if (!entry || !this.host.session.agent.removeQueuedMessage(entry.message)) return undefined;
		this._queued = this._queued.filter((entry) => entry.id !== id);
		this._emitQueueUpdate();
		return queued;
	}

	/** Swap a queued message with its neighbour of the same kind; false at either end or when not queued. */
	move(id: string, direction: "up" | "down"): boolean {
		const entry = this._queued.find((candidate) => candidate.id === id);
		if (!entry) return false;
		const siblings = this._entries(entry.mode);
		const from = siblings.indexOf(entry);
		const neighbour = siblings[direction === "up" ? from - 1 : from + 1];
		if (!neighbour) return false;
		if (!this.host.session.agent.swapQueuedMessages(entry.message, neighbour.message)) return false;
		const a = this._queued.indexOf(entry);
		const b = this._queued.indexOf(neighbour);
		[this._queued[a], this._queued[b]] = [neighbour, entry];
		this._emitQueueUpdate();
		return true;
	}

	/**
	 * Queue a steering or follow-up message (already expanded, no extension command check).
	 */
	async queue(
		mode: "steer" | "followUp",
		text: string,
		images?: ImageContent[],
		input?: PendingUserInput,
	): Promise<void> {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const message: Extract<AgentMessage, { role: "user" }> = {
			role: "user",
			content,
			timestamp: Date.now(),
		};
		if (input) this._pendingUserInputs.set(message, input);
		this._queued.push({ id: `q${this._nextQueuedId++}`, mode, text, message });
		if (mode === "steer") this.host.session.agent.steer(message);
		else this.host.session.agent.followUp(message);
		this._emitQueueUpdate();
	}

	clear(): { steering: string[]; followUp: string[] } {
		const steering = this._texts("steer");
		const followUp = this._texts("followUp");
		this._queued = [];
		this.host.session.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	get pendingMessageCount(): number {
		return this._queued.length;
	}

	addNextTurnMessage(message: CustomMessage): void {
		this._pendingNextTurnMessages.push(message);
	}

	/** Take the pending "nextTurn" messages, which go with the next starting message. */
	takeNextTurnMessages(): CustomMessage[] {
		const messages = this._pendingNextTurnMessages;
		this._pendingNextTurnMessages = [];
		return messages;
	}

	addPendingCustomMessage(message: CustomMessage): void {
		this._pendingCustomMessages.push(message);
	}

	appendCustomMessage(appMessage: CustomMessage): void {
		this.host.session.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this.host.refreshContext();
		this.host.emit({ type: "message_start", message: appMessage });
		this.host.emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this.appendCustomMessage(appMessage);
		}
	}
}
