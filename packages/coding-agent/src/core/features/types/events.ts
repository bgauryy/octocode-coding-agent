/** The union of extension events and the results handlers may return. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, JsonValue, TextContent, Usage } from "@octocodeai/octocode-ai";
import type { BashOperations, BashResult } from "../../tools/bash/types.ts";
import type { CacheWarmingDecisionEvent } from "../../cache-warmer.ts";
import type { CustomMessage } from "../../messages.ts";
import type {
	AgentBeforeSettleEvent,
	AgentEndEvent,
	AgentInterruptedEvent,
	AgentSettledEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	ContextEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnPromptEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptStartEvent,
} from "./agent-events.ts";
import type {
	InputEvent,
	ModelSelectEvent,
	ThinkingLevelSelectEvent,
	UserBashEvent,
	UserInputEvent,
} from "./input-events.ts";
import type { McpServersChangeEvent, ResourcesDiscoverEvent, SessionEvent } from "./session-events.ts";
import type { ToolCallEvent, ToolResultEvent } from "./tool-events.ts";

export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| McpServersChangeEvent
	| SessionEvent
	| ContextEvent
	| CacheWarmingDecisionEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentBeforeSettleEvent
	| AgentInterruptedEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
	| TurnStartEvent
	| TurnPromptEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| UserInputEvent
	| ToolCallEvent
	| ToolResultEvent;

// Event Results
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../../cache-warmer.ts";

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. The tool schema is revalidated before execution. */
	block?: boolean;
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
	/** Only for an `early` call that would need a dialog: withdraw it from the early set; it is judged again, normally, after its message ended. */
	defer?: boolean;
	/**
	 * Run again right before the tool executes, with the same `event.input` the handler saw (a hook may have rewritten it).
	 * A parallel batch approves every call before it runs any, and an approval can wait on a user, so state it relied on
	 * may have changed. Return `{ block: true }` to refuse the call; a throw refuses it with the error message.
	 */
	revalidate?: (signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>;
}

export type UserBashEventResult =
	| {
			/** Custom operations to use for execution */
			operations: BashOperations;
			result?: never;
	  }
	| {
			operations?: never;
			/** Full replacement: extension handled execution, use this result */
			result: BashResult;
	  };

/**
 * Changes a `tool_result` handler makes. Omitted fields stay as they are, except that replacing
 * `content` without returning `structuredContent` drops the structured content, because it may no
 * longer match. Return it along with `content` to keep it.
 */
export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	usage?: Usage;
}

export interface MessageEndEventResult {
	/** Replace the finalized message. The replacement must keep the original message role. */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** Replace the complete system prompt for this turn. Later handlers observe this exact override. */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	/** Override custom instructions for summarization */
	customInstructions?: string;
	/** Override whether customInstructions replaces the default prompt */
	replaceInstructions?: boolean;
	/** Override label to attach to the branch summary entry */
	label?: string;
}
