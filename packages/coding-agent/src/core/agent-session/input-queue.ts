/**
 * Messages waiting for the agent: queued steering and follow-up input with the metadata
 * `user_input` handlers receive, next-turn asides, and context-only custom messages held until the
 * current turn's tool results are in.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import type { CustomMessage } from "../messages.ts";
import type { SessionInternals } from "./host.ts";
import type { PendingUserInput } from "./types.ts";

export class SessionInputQueue {
	// Selected batches retain metadata across clearQueue; removed queue objects are weakly held.
	private readonly _pendingUserInputs = new WeakMap<AgentMessage, PendingUserInput>();
	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	private _queuedUserMessages = new WeakMap<AgentMessage, { mode: "steer" | "followUp"; text: string }>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	private readonly host: Pick<SessionInternals, "session" | "emit" | "refreshContext">;

	constructor(host: Pick<SessionInternals, "session" | "emit" | "refreshContext">) {
		this.host = host;
	}

	get steeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	get followUpMessages(): readonly string[] {
		return this._followUpMessages;
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
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	consumeQueuedUserMessage(message: AgentMessage): void {
		const queued = this._queuedUserMessages.get(message);
		if (!queued) return;
		this._queuedUserMessages.delete(message);
		const messages = queued.mode === "steer" ? this._steeringMessages : this._followUpMessages;
		const index = messages.indexOf(queued.text);
		if (index !== -1) {
			messages.splice(index, 1);
			this._emitQueueUpdate();
		}
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
		const message: AgentMessage = {
			role: "user",
			content,
			timestamp: Date.now(),
		};
		if (input) this._pendingUserInputs.set(message, input);
		this._queuedUserMessages.set(message, { mode, text });
		if (mode === "steer") {
			this.host.session.agent.steer(message);
			this._steeringMessages.push(text);
		} else {
			this.host.session.agent.followUp(message);
			this._followUpMessages.push(text);
		}
		this._emitQueueUpdate();
	}

	clear(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.host.session.agent.clearAllQueues();
		this._queuedUserMessages = new WeakMap();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
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
