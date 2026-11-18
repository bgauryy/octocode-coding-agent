/** Agent, provider, turn, message and tool execution events. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type {
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
} from "@octocodeai/octocode-ai";
import type { Question } from "@octocodeai/octocode-contracts";
import type { AskView } from "./ui.ts";
import type { RunOutcome } from "../../agent-session/run-outcome.ts";
import type { CustomMessage } from "../../messages.ts";
import type { ContextEditEntry, ReadonlyProjectedSessionEntry } from "../../session-manager.ts";
import type { NormalizedBuildSystemPromptOptions } from "../../system-prompt.ts";

// Agent Events
// ============================================================================

/**
 * Fired before each LLM call. Can modify messages.
 *
 * `messages` holds the conversation without system messages. The prompt and tool state
 * belong to Octocode: it restores them after the handler returns, so a handler cannot drop
 * them and does not need to preserve them.
 */
export interface ContextEvent {
	type: "context";
	/** The conversation without system messages; edit it or return a new list. */
	messages: AgentMessage[];
	/** The whole transcript as the request sends it, system messages included (read-only: changes are ignored). */
	readonly transcript?: readonly AgentMessage[];
}

interface BeforeAgentStartEventBase {
	type: "before_agent_start";
	/** The current system prompt, rendered from systemPromptOptions and earlier handler changes. */
	readonly systemPrompt: string;
	/** Mutable prompt sections. Later handlers observe mutations made by earlier handlers. */
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/** A run started by a submitted prompt, RPC prompt, or `api.session.sendUserMessage()`. */
export interface BeforeAgentStartUserEvent extends BeforeAgentStartEventBase {
	messageType: "user";
	/** The raw user prompt text (after expansion). */
	prompt: string;
	/** Images attached to the user prompt, if any. */
	images?: ImageContent[];
}

/** A run started by `api.session.sendMessage(..., { triggerTurn: true })` while idle. */
export interface BeforeAgentStartCustomEvent extends BeforeAgentStartEventBase {
	messageType: "custom";
	/** The custom message that starts the run. */
	message: CustomMessage;
}

/** Fired before a run starts from a user message or an idle custom message with `triggerTurn`. */
export type BeforeAgentStartEvent = BeforeAgentStartUserEvent | BeforeAgentStartCustomEvent;

/** Fired when an agent loop starts */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

export type AgentActivityOutcome = "completed" | "aborted" | "error";

interface CustomEntryDraft {
	type: "custom";
	customType: string;
	data?: unknown;
}

interface CustomMessageEntryDraft {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
}

export interface ContextEditEntryDraft {
	type: "context_edit";
	targetId: string;
	replacement: ContextEditEntry["replacement"];
}

export type SessionBoundaryDraft = CustomEntryDraft | CustomMessageEntryDraft | ContextEditEntryDraft;

export interface BoundaryContextPreview {
	/** Shared with the session's kept projection: read only. */
	contextEntries: readonly ReadonlyProjectedSessionEntry[];
	contextMessages: readonly AgentMessage[];
	llmMessages: Message[];
	pendingMessages: AgentMessage[];
	canContinue: boolean;
}

interface BoundaryState {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	outcome: AgentActivityOutcome;
}

export interface BoundaryResult {
	entries?: SessionBoundaryDraft[];
	continue?: boolean;
}

/** Fired before final settlement. May append entries and ensure one next provider request. */
export interface AgentBeforeSettleEvent extends BoundaryState {
	type: "agent_before_settle";
}

/** Observes an explicitly interrupted turn after its records are saved and before settlement. */
export interface AgentInterruptedEvent {
	type: "agent_interrupted";
	turnId: string;
	sessionId: string;
	transcriptPath?: string;
	cwd: string;
	model: Model<any> | undefined;
}

/** Fired after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run. */
export interface AgentSettledEvent {
	type: "agent_settled";
	/** Whether the run ended because it was aborted, for example with Escape. */
	aborted: boolean;
	/** How the run ended, which the context cannot answer: recovery removes failed attempts from it. */
	outcome?: RunOutcome;
}

/**
 * Fired after the `agent_settled` handlers returned and the sends they deferred ran, also when there were none. A run one of
 * those sends started has begun by then: a message sent while the run settled and still not taken up started nothing.
 */
export interface AgentSettleEndEvent {
	type: "agent_settle_end";
}

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom" | "ask";

/**
 * Fired when Octocode starts waiting on a blocking user-facing feature UI prompt. `id` names the dialog for a
 * remote answer (`AgentSession.answerDialog`); `options` are a select's choices (a confirm's are Yes and No);
 * `allowsText` says an input dialog takes free text; `approval` is set when an `ask` dialog holds an approval question, `blocking` repeats the dialog option;
 * `nested` marks a dialog opened over another still open one.
 */
export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
	id?: string;
	options?: string[];
	allowsText?: boolean;
	approval?: boolean;
	/** The card a custom dialog with a remote answer shape draws, for clients that draw it too. */
	ask?: AskView;
	/** An `ask` dialog's typed questions (`SessionUI.ask`), which a remote client answers with one reply each. */
	questions?: Question[];
	blocking?: boolean;
	nested?: boolean;
}

/** Fired when Octocode is no longer waiting on a blocking user-facing feature UI prompt. */
export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
	id?: string;
	nested?: boolean;
}

export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/**
 * Fired before each later request of a run, with the prompt options for that turn (the run's options from
 * `before_agent_start` and the current tools). Handlers may update sections whose content changed during the run, such
 * as MCP server blocks and status; Octocode sends what differs as a section patch.
 */
export interface TurnPromptEvent {
	type: "turn_prompt";
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

export interface TurnEndEvent extends BoundaryState {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
	messageEntryId: string;
	toolResultEntryIds: string[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
	/** Set when another tool (for example another tool) made this call. */
	parentToolCallId?: string;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
	/** Set when another tool (for example another tool) made this call. */
	parentToolCallId?: string;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
	/** Milliseconds `execute()` took, measured with a monotonic clock; absent when the tool did not run. */
	durationMs?: number;
	/** Set when another tool (for example another tool) made this call. */
	parentToolCallId?: string;
}
