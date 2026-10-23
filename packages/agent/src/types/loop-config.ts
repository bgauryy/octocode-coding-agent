import type {
	AssistantMessage,
	ImageContent,
	JsonValue,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@octocodeai/octocode-ai";
import type {
	AgentContext,
	AgentMessage,
	AgentToolCall,
	AgentToolResult,
	ThinkingLevel,
	ToolExecutionMode,
} from "./core.ts";

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `usage`: if provided, replaces the tool result usage
 * - `terminate`: if provided, replaces the early-termination hint
 * - `structuredContent`: if provided, replaces the structured content. If `content` is provided
 *   without it, the structured content is dropped, because it may no longer match the content.
 *   Return it along with `content` to keep it.
 *
 * Other omitted fields keep the original executed tool result values.
 * There is no deep merge for `content`, `details`, or `usage`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	usage?: Usage;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Context passed to completed-turn callbacks. */
export interface AgentTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages emitted for the completed turn. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

/** Decision returned by {@link FinishTurn}. Returning undefined preserves normal scheduling. */
export type AgentTurnDecision = { action: "continue" } | { action: "end" };

/**
 * Called after a completed assistant turn and all of its tool-result messages, but before `turn_end`.
 * On a normal turn, `{ action: "continue" }` ensures one next provider request. Tool-result, steering, or
 * follow-up scheduling can satisfy that request and adds no extra request; otherwise the loop continues once
 * with the current context. Error and aborted responses remain hard exits.
 */
export type FinishTurn = (
	turn: AgentTurnContext,
	signal?: AbortSignal,
) => AgentTurnDecision | void | Promise<AgentTurnDecision | undefined> | Promise<void>;

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Messages to append before the next provider request, with normal lifecycle events. */
	messages?: AgentMessage[];
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

/** Runtime state available immediately before a conversational provider request. */
export interface PrepareRequestContext {
	context: AgentContext;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
}

/** Replacement runtime state for the provider request being prepared. */
export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

/**
 * Called immediately before every conversational provider request, including the first.
 * Pending messages have already been appended and emitted when this callback runs.
 */
export type PrepareRequest = (
	request: PrepareRequestContext,
	signal?: AbortSignal,
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

export interface PrepareNextTurnContext extends AgentTurnContext {}

export interface InputBatch {
	kind: "initial" | "steer" | "followUp";
	messages: AgentMessage[];
}

/** Record finalized input; an optional signal stops between messages without undoing prior records. */
export type CommitInput = (messages: AgentMessage[], signal?: AbortSignal) => Promise<void>;

/** Commit finalized items incrementally; return only remaining messages. Stop suppresses the next request. */
export type PrepareInput = (
	batch: InputBatch,
	signal: AbortSignal | undefined,
	commit: CommitInput,
) => { messages: AgentMessage[]; stop?: boolean } | Promise<{ messages: AgentMessage[]; stop?: boolean }>;

export interface AgentLoopConfig extends SimpleStreamOptions {
	prepareInput?: PrepareInput;
	/** Called when a nonempty batch is selected, before continuation preparation. */
	onInputSelected?: (batch: InputBatch) => void;
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a SystemMessage, UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after the assistant message and all tool-result messages have been emitted, immediately before `turn_end`.
	 * `{ action: "end" }` ends the run without polling queues or preparing another request.
	 * On a normal turn, `{ action: "continue" }` ensures one next provider request. Tool-result, steering, or
	 * follow-up scheduling can satisfy that request and adds no extra request; otherwise the loop continues once
	 * with the current context. Returning undefined preserves normal scheduling. Error and aborted responses remain
	 * hard exits.
	 */
	finishTurn?: FinishTurn;

	/**
	 * Called immediately before every conversational provider request, including the first.
	 * Pending messages have already been appended. The returned context, model, and thinking level
	 * replace the runtime values for this and later requests in the run. This hook does not poll queues.
	 */
	prepareRequest?: PrepareRequest;

	/**
	 * Called after `turn_end` when the loop will continue, immediately before the next turn starts.
	 * Return replacement context/model/thinking state or messages to append to affect that turn.
	 * Return undefined to keep using the current context/config.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `finishTurn` ends the run.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * A blocked result can also set `terminate: true` to participate in the batch early-termination rule.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `usage` replaces the tool result usage
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

	/**
	 * Called when the model calls a tool the request did not declare. Return the error text the model gets instead of
	 * `Tool <name> not found`, for example how to make the tool available; undefined keeps the default.
	 */
	unknownToolMessage?: (toolName: string) => string | undefined;
}
