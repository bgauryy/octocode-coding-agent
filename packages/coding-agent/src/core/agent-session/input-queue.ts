/**
 * Messages waiting for the agent: queued steering and follow-up input with the metadata
 * `user_input` handlers receive, next-turn asides, and context-only custom messages held until the
 * current turn's tool results are in.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import { assertImageInputSupported } from "@octocodeai/octocode-ai/utils/image-input";
import { withoutSourceHeader } from "@octocodeai/octocode-common/text";
import { adoptDeliveredOrigins, inputOrigin, type InputOrigin as ClientOrigin } from "../input-origin.ts";
import type { CustomMessage } from "../messages.ts";
import type { InputOrigin } from "../session-manager/types.ts";
import type { SessionInternals } from "./host.ts";
import type { PendingUserInput, QueuedInput, ReleasedQueuedInput } from "./types.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { recordRunWarning, type RunOutcome } from "./run-outcome.ts";

interface QueuedEntry {
	id: string;
	mode: "steer" | "followUp";
	text: string;
	message: Extract<AgentMessage, { role: "user" }>;
	/** The client the message was sent from: delivery runs the work it triggers under this origin. */
	client: ClientOrigin;
	/** Out of the agent's queue while the user edits it; the entry keeps its place here. */
	held?: true;
}

export class SessionInputQueue {
	// Selected batches retain metadata across clearQueue; removed queue objects are weakly held.
	private readonly _pendingUserInputs = new WeakMap<AgentMessage, PendingUserInput>();
	/** How messages entered: the queue they came through, else what their input metadata says (kept when it is deleted). */
	private readonly _origins = new WeakMap<AgentMessage, InputOrigin>();
	/** Messages in the agent's steering and follow-up queues, in queue order. Removed when delivery begins. */
	private _queued: QueuedEntry[] = [];
	private _nextQueuedId = 1;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	/** Custom messages steered into the running agent (team mail), until the agent takes them. */
	private readonly _steeredCustomMessages = new Set<CustomMessage>();
	// Custom messages handed to the agent's steering or follow-up queue; pruned once the agent no longer holds them.
	private readonly _queuedCustomMessages = new Set<CustomMessage>();

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
			...(entry.held ? { held: true as const } : {}),
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

	/** How a user message entered the agent, for its stored entry; undefined when nothing recorded it. */
	originOf(message: AgentMessage): InputOrigin | undefined {
		const queued = this._origins.get(message);
		if (queued) return queued;
		const input = this._pendingUserInputs.get(message);
		if (!input) return undefined;
		return input.origin ?? (input.source === "interactive" ? "typed" : "api");
	}

	/** The `user_input` metadata of a queued or starting message. */
	getUserInput(message: AgentMessage): PendingUserInput | undefined {
		return this._pendingUserInputs.get(message);
	}

	setUserInput(message: AgentMessage, input: PendingUserInput): void {
		this._pendingUserInputs.set(message, input);
	}

	deleteUserInput(message: AgentMessage): void {
		const origin = this.originOf(message);
		if (origin) this._origins.set(message, origin);
		this._pendingUserInputs.delete(message);
	}

	private _emitQueueUpdate(): void {
		this.host.emit({
			type: "queue_update",
			steering: this._texts("steer"),
			followUp: this._texts("followUp"),
		});
	}

	/** Delivery of `message` begins: it leaves the queue and can no longer be edited. Returns the client it was sent from. */
	consumeQueuedUserMessage(message: AgentMessage): ClientOrigin | undefined {
		const index = this._queued.findIndex((entry) => entry.message === message);
		if (index === -1) return undefined;
		const [entry] = this._queued.splice(index, 1);
		this._emitQueueUpdate();
		return entry.client;
	}

	/** Selected messages enter the running run: the work they trigger runs under the origin they were sent from. */
	deliverSelected(messages: readonly AgentMessage[]): void {
		adoptDeliveredOrigins(messages.flatMap((message) => this.consumeQueuedUserMessage(message) ?? []));
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
		this._setText(entry, text);
		this._emitQueueUpdate();
		return "replaced";
	}

	private _setText(entry: QueuedEntry, text: string): void {
		const { message } = entry;
		const parts = Array.isArray(message.content) ? message.content : [];
		const attachments = parts.filter((part) => part.type !== "text");
		message.content = [{ type: "text", text }, ...attachments];
		entry.text = text;
		const input = this._pendingUserInputs.get(message);
		if (input) this._pendingUserInputs.set(message, { ...input, text, expandedPaths: undefined });
	}

	/** Take a message out of delivery while it is edited; undefined when delivery has begun or it is already held. */
	hold(id: string): QueuedInput | undefined {
		const entry = this._queued.find((candidate) => candidate.id === id);
		if (!entry || entry.held || !this.host.session.agent.removeQueuedMessage(entry.message)) return undefined;
		entry.held = true;
		this._emitQueueUpdate();
		return this.queuedInputs.find((candidate) => candidate.id === id);
	}

	/**
	 * Put a held message back before the next queued message of its kind, with new text when given (blank removes it).
	 * With no run active it leaves the queue ("idle"): a queued message would otherwise wait for an unrelated run.
	 */
	release(id: string, text?: string): ReleasedQueuedInput {
		const entry = this._queued.find((candidate) => candidate.id === id && candidate.held);
		if (!entry) return { outcome: "missing" };
		delete entry.held;
		const drop = () => {
			this._queued = this._queued.filter((candidate) => candidate !== entry);
			this._emitQueueUpdate();
		};
		if (text !== undefined && !text.trim()) {
			drop();
			return { outcome: "removed" };
		}
		if (text !== undefined && text !== entry.text) this._setText(entry, text);
		if (!this.host.session.isStreaming) {
			drop();
			const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
			return {
				outcome: "idle",
				mode: entry.mode,
				text: entry.text,
				images: parts.filter((part) => part.type === "image"),
				source: this._pendingUserInputs.get(entry.message)?.source ?? "interactive",
			};
		}
		const agent = this.host.session.agent;
		const next = this._queued
			.slice(this._queued.indexOf(entry) + 1)
			.find((candidate) => candidate.mode === entry.mode && agent.hasQueuedMessage(candidate.message));
		agent.placeQueuedMessage(entry.message, entry.mode, next?.message);
		this._emitQueueUpdate();
		return { outcome: "queued" };
	}

	/** Switch a queued message between the steering and follow-up queues; it goes last among its new kind. */
	setMode(id: string, mode: "steer" | "followUp"): boolean {
		const entry = this._queued.find((candidate) => candidate.id === id);
		if (!entry || !this.host.session.agent.hasQueuedMessage(entry.message)) return false;
		if (entry.mode === mode) return true;
		this.host.session.agent.placeQueuedMessage(entry.message, mode);
		entry.mode = mode;
		this._origins.set(entry.message, mode === "steer" ? "steer" : "follow-up");
		this._queued = [...this._queued.filter((candidate) => candidate !== entry), entry];
		this._emitQueueUpdate();
		return true;
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
	 * Queue a steering or follow-up message (already expanded, no feature command check).
	 */
	async queue(
		mode: "steer" | "followUp",
		text: string,
		images?: ImageContent[],
		input?: PendingUserInput,
	): Promise<void> {
		assertImageInputSupported(this.host.session.model, images ?? []);
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
		this._origins.set(message, mode === "steer" ? "steer" : "follow-up");
		// The queue shows and returns what the user typed, without the source header the model reads.
		const id = `q${this._nextQueuedId++}`;
		this._queued.push({ id, mode, text: withoutSourceHeader(text), message, client: inputOrigin() });
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

	/** Records a custom message handed to the agent's steering queue, so a running tool can see that it waits. */
	noteSteeredCustomMessage(message: CustomMessage): void {
		this._steeredWaiting();
		this._steeredCustomMessages.add(message);
	}

	/**
	 * Whether a custom message that asks for the agent now is waiting: one steered into the running agent to start a turn
	 * (the user's mail, a question). Context-only messages (`triggerTurn: false`: notices, FYIs) are read at the next step
	 * without making a running tool yield; follow-ups (background reports) wait for the run to end.
	 */
	get hasWaitingCustomMessages(): boolean {
		return this._steeredWaiting();
	}

	/** Forgets the steered messages the agent took; whether one is still queued. */
	private _steeredWaiting(): boolean {
		let waiting = false;
		for (const message of this._steeredCustomMessages) {
			if (this.host.session.agent.hasQueuedMessage(message)) waiting = true;
			else this._steeredCustomMessages.delete(message);
		}
		return waiting;
	}

	/** Records a custom message handed to the agent's steering or follow-up queue, so its sender can ask whether it waits. */
	noteQueuedCustomMessage(message: CustomMessage): void {
		this._pruneQueuedCustomMessages();
		this._queuedCustomMessages.add(message);
	}

	/** Whether a custom message sent with this exact `details` object (identity, never equality) still waits in the agent's queue. */
	isCustomMessageQueued(details: object): boolean {
		this._pruneQueuedCustomMessages();
		for (const message of this._queuedCustomMessages) if (message.details === details) return true;
		return false;
	}

	/** Rewrites a custom message sent with this exact `details` object while it waits; false once it was read. */
	replaceQueuedCustomMessage(details: object, content: string): boolean {
		this._pruneQueuedCustomMessages();
		const message = [...this._queuedCustomMessages, ...this._pendingCustomMessages].find(
			(waiting) => waiting.details === details,
		);
		if (message) message.content = content;
		return message !== undefined;
	}

	private _pruneQueuedCustomMessages(): void {
		for (const message of this._queuedCustomMessages)
			if (!this.host.session.agent.hasQueuedMessage(message)) this._queuedCustomMessages.delete(message);
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
			appMessage.timestamp,
		);
		// Announce the message before the refresh: the first event after the refresh makes transcript views rebuild from
		// every entry, so a view told about the message afterwards would show it twice.
		this.host.emit({ type: "message_start", message: appMessage });
		this.host.emit({ type: "message_end", message: appMessage });
		this.host.refreshContext();
	}

	/**
	 * Flushes during a run: a message that cannot be written yet stays queued for the next write and is reported, because
	 * the run itself is fine and a lock another process holds for a moment must not end it.
	 */
	flushDuringRun(outcome: RunOutcome): void {
		try {
			this.flushPendingCustomMessages();
		} catch (error) {
			recordRunWarning(outcome, errorMessage(error));
		}
	}

	flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const [index, appMessage] of pending.entries()) {
			try {
				this.appendCustomMessage(appMessage);
			} catch (error) {
				// Keep what was not written (a failed append changes nothing), so the next flush can still deliver it.
				this._pendingCustomMessages = [...pending.slice(index), ...this._pendingCustomMessages];
				throw error;
			}
		}
	}
}
