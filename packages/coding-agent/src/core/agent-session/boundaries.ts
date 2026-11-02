/**
 * Turn and settle boundaries: the `turn_end` and `agent_before_settle` extension boundaries with
 * their draft entries and continuation checks, and the map from projected messages to the session
 * entries they come from.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@octocodeai/octocode-ai/compat";
import type { AgentActivityOutcome, BoundaryContextPreview, SessionBoundaryDraft } from "../features/index.ts";
import { convertToLlm, type CustomMessage } from "../messages.ts";
import { type SessionEntry, SessionManager } from "../session-manager.ts";
import type { SessionInternals } from "./host.ts";

export interface BoundariesHost extends Pick<SessionInternals, "session" | "run" | "cwd" | "emit"> {
	pendingCustomMessages(): readonly CustomMessage[];
	flushPendingCustomMessages(): void;
}

interface BoundaryProjection {
	drafts: SessionBoundaryDraft[];
	leafId: string | null;
	projection: ReturnType<SessionManager["buildSessionProjection"]>;
	llmMessages: ReturnType<typeof convertToLlm>;
	finalRole: string | undefined;
	contextCanContinue: boolean;
}

export class SessionBoundaries {
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	/** The last projection of the branch with its drafts; see `_projectBoundary`. */
	private _boundaryProjection: BoundaryProjection | undefined;

	private readonly host: BoundariesHost;

	constructor(host: BoundariesHost) {
		this.host = host;
	}

	recordEntryId(message: AgentMessage, entryId: string): void {
		this._entryIdsByMessage.set(message, entryId);
	}

	/** Whether `turn_end` was already dispatched for the message by `finishTurn`; forgets it. */
	takeDispatched(message: AgentMessage): boolean {
		return this._boundaryDispatchedMessages.delete(message);
	}

	refreshFinalizedContext(): void {
		const projection = this.host.session.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.host.session.agent.state.messages = projection.messages;
		this.host.emit({ type: "session_context_changed" });
	}

	findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const { session } = this.host;
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...session.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = session.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = session.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	/**
	 * Persistently omit a failed attempt and its tool results from model context. The results are found in the
	 * projected context, so the pair stays together whether the attempt comes from the current run or a resumed
	 * session; an unpaired tool result fails the next request (#11227).
	 */
	omitRecoveryAttempt(message: AssistantMessage): void {
		const { session } = this.host;
		const toolCallIds = new Set(message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
		// A context edit replaces the projected copy, so match it by source entry as well.
		const entryId = this.findPersistedMessageEntryId(message);
		const messages = session.agent.state.messages;
		const index = messages.findIndex(
			(m) => m === message || (entryId !== undefined && this._entryIdsByMessage.get(m) === entryId),
		);
		const toolResults: AgentMessage[] = [];
		for (const m of index < 0 ? [] : messages.slice(index + 1)) {
			if (m.role === "assistant") break;
			if (m.role === "toolResult" && toolCallIds.has(m.toolCallId)) toolResults.push(m);
		}
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this.findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && session.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = session.sessionManager.appendContextEdit(targetId, null);
			const entry = session.sessionManager.getEntry(editId);
			if (entry) this.host.emit({ type: "entry_appended", entry });
		}
		this.refreshFinalizedContext();
	}

	async dispatchTurnEnd(message: AssistantMessage, toolResults: ToolResultMessage[]): Promise<boolean> {
		const { session, run } = this.host;
		this._lastActivityOutcome =
			run.agentRunAbortRequested || session.agent.signal?.aborted || message.stopReason === "aborted"
				? "aborted"
				: message.stopReason === "error"
					? "error"
					: "completed";
		const messageEntryId = this.findPersistedMessageEntryId(message);
		const runner = session.extensionRunner;
		if (!runner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			runner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this.findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		try {
			const boundary = await runner.emitBoundary(
				{
					type: "turn_end",
					turnIndex: run.turnIndex,
					message,
					toolResults,
					messageEntryId,
					toolResultEntryIds,
					outcome: this._lastActivityOutcome,
				},
				(entries) => this._buildBoundaryContext(entries, "turn_end"),
			);
			this._commitBoundaryDrafts(boundary.entries);
			if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
				this._reportInvalidBoundaryContinuation("turn_end");
				return false;
			}
			return boundary.continue;
		} finally {
			this._boundaryProjection = undefined;
		}
	}

	installFinishTurn(): void {
		const { session, run } = this.host;
		const previousFinishTurn = session.agent.finishTurn;
		session.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this.dispatchTurnEnd(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (run.extensionRunAbortRequested) return { action: "end" };
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				default:
					throw new Error("Unsupported boundary entry; compaction is managed by the built-in policy");
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const sessionManager = this.host.session.sessionManager;
		const header = sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this.host.cwd, undefined, [header, ...sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.host.session.agent.peekQueuedMessages(), ...this.host.pendingCustomMessages()];
	}

	/**
	 * Project the branch with the drafts applied. Copying the branch and projecting it is
	 * O(branch), and a boundary asks for it once per handler and again to check continuation,
	 * so the result is reused while the drafts and the branch leaf are unchanged. Queue state
	 * is not part of it and is read fresh by the caller.
	 */
	private _projectBoundary(drafts: SessionBoundaryDraft[]): BoundaryProjection {
		const leafId = this.host.session.sessionManager.getLeafId();
		const cached = this._boundaryProjection;
		if (
			cached &&
			cached.leafId === leafId &&
			(cached.drafts === drafts || (cached.drafts.length === 0 && drafts.length === 0))
		) {
			return cached;
		}
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const built = {
			drafts,
			leafId,
			projection,
			llmMessages,
			finalRole,
			contextCanContinue: hasNonSystemContext && finalRole !== "assistant",
		};
		this._boundaryProjection = built;
		return built;
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const agent = this.host.session.agent;
		const { projection, llmMessages, finalRole, contextCanContinue } = this._projectBoundary(drafts);
		const pendingMessages = this._getPendingBoundaryMessages();
		const pendingCustomContext = this.host.pendingCustomMessages().length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end" ? agent.hasQueuedMessages() : finalRole === "assistant" && agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		const appended = this._applyBoundaryDrafts(this.host.session.sessionManager, drafts);
		this.refreshFinalizedContext();
		for (const entry of appended) this.host.emit({ type: "entry_appended", entry });
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this.host.session.extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	async runBeforeSettle(): Promise<boolean> {
		const { session, run } = this.host;
		const runner = session.extensionRunner;
		if (!runner.hasHandlers("agent_before_settle")) return session.agent.hasQueuedMessages();
		run.isBeforeSettle = true;
		run.abortDuringBeforeSettle = false;
		try {
			const result = await runner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this.host.flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (run.abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || session.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			run.isBeforeSettle = false;
			this._boundaryProjection = undefined;
		}
	}
}
