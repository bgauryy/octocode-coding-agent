/** Contexts passed to extension handlers, tools and commands. */

import type {
	AgentTool,
	AgentToolCallOutcome,
	AgentToolUpdateCallback,
	ThinkingLevel,
} from "@octocodeai/octocode-agent-core";
import type { ImageContent, Model, TextContent } from "@octocodeai/octocode-ai";
import type { CompactionResult } from "../../compaction/index.ts";
import type { CustomMessage } from "../../messages.ts";
import type { ModelRegistry } from "../../model-registry.ts";
import type { ScopedModel } from "../../model-resolver.ts";
import type { ReadonlySessionManager, SessionManager } from "../../session-manager.ts";
import type { BuildSystemPromptOptions } from "../../system-prompt.ts";
import type { ExtensionUIContext } from "./ui.ts";

// ============================================================================
// Extension Context
// ============================================================================

export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * Context passed to extension event handlers.
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
	/** UI methods for user interaction */
	ui: ExtensionUIContext;
	/** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
	mode: ExtensionMode;
	/** Whether dialog-capable UI is available (true in TUI and RPC modes) */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined) */
	model: Model<any> | undefined;
	/** Models scoped to this session (resolved from `--models` /
	 *  `enabledModels` settings against the available catalogue). Same set
	 *  the `/modelsettings` catalog shows. Empty when no scoping is
	 *  configured (all available models are usable). Read-only snapshot. */
	scopedModels: readonly ScopedModel[];
	/** Current thinking level, when provided by the session runtime. */
	thinkingLevel?: ThinkingLevel;
	/** Tools explicitly selected through the session's CLI or SDK policy. */
	readonly explicitToolNames?: readonly string[];
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Whether project-local trust is active for this context. */
	isProjectTrusted(): boolean;
	/** The call's abort signal in tool_call handlers; otherwise the current turn's signal, if streaming. */
	signal: AbortSignal | undefined;
	/** Abort the current agent operation */
	abort(reason?: "interrupted" | "internal"): void;
	/** Whether there are queued messages waiting */
	hasPendingMessages(): boolean;
	/** Gracefully shutdown Octocode and exit. Available in all contexts. */
	shutdown(): void;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Current logical user turn, shared by its tool calls, steering and retries. */
	getTurnId(): string | undefined;
	/** Trigger compaction without awaiting completion. */
	compact(options?: CompactOptions): void;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string;
}

/** Options for {@link ExtensionToolContext.executeTool}. */
export interface ExecuteToolOptions {
	/** Defaults to the calling tool's signal. */
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	onUpdate?: AgentToolUpdateCallback;
}

/** Immutable arguments of the active tool execution; unavailable after that execution settles. */
export interface ToolInvocation {
	/** False after execution settles, including on contexts copied while the call was active. */
	readonly active: boolean;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

/**
 * Context passed to tool `execute()` in a session: the extension context plus `executeTool()`
 * for running other tools through the same validation, hooks, and permission checks as
 * model-issued calls.
 *
 * A tool wrapped with `wrapToolDefinition()` without a context factory, such as a built-in tool
 * created with `createBashTool()` and run in a plain `Agent` or called directly, gets no context.
 */
export interface ExtensionToolContext extends ExtensionContext {
	readonly invocation?: ToolInvocation;
	/** Tools {@link executeTool} can call. */
	readonly tools: readonly AgentTool[];
	/**
	 * Run another tool. The call gets the id `<calling id>/<n>`, and the `tool_call`, `tool_result`,
	 * and `tool_execution_*` events carry `parentToolCallId`. It does not appear in the transcript;
	 * a bounded record of it is kept as `nestedCalls` on the calling tool's result message.
	 *
	 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
	 * errors come back as `isError: true`.
	 */
	executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** Get the current base system-prompt construction options. */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/** Start a new session, optionally with initialization. */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** Fork from a specific entry, creating a new session file. */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** Switch to a different session file. */
	switchSession(
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** Reload extensions, skills, prompts, themes, and context files. */
	reload(): Promise<void>;
}

/**
 * Fresh command-capable context bound to the replacement session after a session switch.
 *
 * This is passed to `withSession()` callbacks on `newSession()`, `fork()`, and `switchSession()`.
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
}
