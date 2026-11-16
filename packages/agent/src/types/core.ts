import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
	JsonValue,
	Message,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolCallPhases,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@octocodeai/octocode-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * The loop passes a normalized transcript: the system prompt and tool
 * declarations are carried by the transcript's system messages, never by
 * `context.systemPrompt` or `context.tools`.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, and each allowed call starts as soon as its own preparation
 *   ends, ordered by its {@link ToolConcurrency}. `tool_execution_end` is emitted in tool completion order after each
 *   tool is finalized, while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * How one call orders against the other calls of its assistant message in a parallel batch.
 * - "shared": runs beside other shared calls, after the last exclusive call before it ended.
 * - "exclusive": runs alone: after every earlier call ended, and every later call waits for it.
 */
export type ToolConcurrency = "shared" | "exclusive";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata from @octocodeai/octocode-ai to detect support for a concrete model.
 */
export type ThinkingLevel = ModelThinkingLevel;

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@octocodeai/octocode-agent-core" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- empty by design: apps extend it through declaration merging
export interface CustomAgentMessages {}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/**
	 * Current system prompt, replayed from the transcript's system messages.
	 *
	 * Read-only: to change the prompt, append a system message with `content` or `sections`.
	 * In `initialState`, this seeds the leading system message.
	 */
	readonly systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/**
	 * Executable tools. Assigning a new array copies the top-level array.
	 *
	 * Differences from the tools declared in the transcript are announced to the model
	 * with a system message before the next request.
	 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/**
	 * Conversation transcript. Assigning a new array copies the top-level array.
	 *
	 * System messages in the transcript carry the prompt and tool declarations.
	 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

/** Progress reported by a running tool: `progress` grows; `total` is set when the amount of work is known. */
export interface AgentToolProgress {
	progress: number;
	total?: number;
	message?: string;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T = JsonValue | undefined> {
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/**
	 * Machine-readable result matching the tool's `outputSchema`, for programmatic callers. Not sent
	 * to the model; `content` remains the model-facing result.
	 */
	structuredContent?: JsonValue;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	usage?: Usage;
	/** How far a running tool is, set on partial updates for views to show. Not sent to the model. */
	progress?: AgentToolProgress;
	/**
	 * Report a failure without throwing. The model sees `content` as an error result, like a thrown
	 * error, but `details` and `structuredContent` are kept for the UI and programmatic callers.
	 */
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Final outcome of a tool call after hooks ran. */
export interface AgentToolCallOutcome {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	/** Milliseconds `execute()` took, measured with a monotonic clock; absent when the tool did not run. */
	durationMs?: number;
	/** The call's time around `execute()`: preparation, schedule wait and finalization (`ToolCallPhases`). */
	phases?: ToolCallPhases;
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/**
	 * JSON Schema of `structuredContent` in successful results. Tools that declare it should always
	 * set `structuredContent`.
	 */
	outputSchema?: TSchema;
	/**
	 * Execute the tool call. Throw on failure, or return a result with `isError: true`; do not only
	 * describe the failure in `content`.
	 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
	replay?: "never" | "safe";
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls: an exclusive call (see `concurrency`).
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
	/**
	 * The call's {@link ToolConcurrency}, fixed or from its validated arguments; a resolver that throws makes the call
	 * exclusive. Takes precedence over `executionMode`; omitted, a "sequential" tool is exclusive and any other shared.
	 */
	concurrency?: ToolConcurrency | ((args: Record<string, unknown>) => ToolConcurrency);
	/**
	 * How long a call may keep running after an abort before the loop abandons it, in ms. For a tool whose stop takes
	 * longer than the short default (a command given time to clean up after SIGTERM) and that then returns what it has.
	 */
	abortGraceMs?: number;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for execution in this run. */
	tools?: AgentTool<any>[];
	/**
	 * Names of tools the host has declared to the model that are not executable yet, for example tools of a
	 * server that is still connecting. They stay declared: the loop does not declare them removed while they
	 * are absent from `tools`. Once the host drops a name from this set and `tools` still lacks it, the tool is
	 * declared removed as usual. A call to one before it registers is a tool error (see `unknownToolMessage`).
	 */
	pendingToolNames?: () => ReadonlySet<string>;
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for system, user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming. `message` is a live view: a shallow copy whose `content`
	// array and blocks the provider keeps mutating, so a handler that runs after later deltas arrive sees them too.
	// Read what you need while handling the event, or copy it, and take the delta from `assistantMessageEvent`;
	// `message_end` carries the final message.
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError: boolean;
			/** Milliseconds `execute()` took, measured with a monotonic clock; absent when the tool did not run. */
			durationMs?: number;
	  };
