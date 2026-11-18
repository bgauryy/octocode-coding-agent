/** Public and internal types of `AgentSession`: its events, configuration and option shapes. */

import type { Agent, AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { ImageContent, Model } from "@octocodeai/octocode-ai/compat";
import type { CacheWarmer } from "../cache-warmer.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type {
	CommandActions,
	FeatureErrorListener,
	UiMode,
	FeatureHost,
	SessionUI,
	InputSource,
	SessionStartEvent,
	ShutdownHandler,
	ToolDefinition,
} from "../features/index.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader/types.ts";
import type { InputOrigin, SessionEntry, SessionManager, SessionNameSource } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SourceInfo } from "../source-info.ts";
import type { RunOutcome } from "./run-outcome.ts";

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; aborted: boolean; outcome?: RunOutcome }
	| { type: "session_dispatch"; active: boolean; dispatchId: string }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	/** A compaction's summary is streaming: at most once a second while it runs (`SummaryProgress`). */
	| {
			type: "compaction_progress";
			reason: "manual" | "threshold" | "overflow";
			elapsedMs: number;
			receivedChars: number;
	  }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined; source?: SessionNameSource }
	| { type: "session_context_changed" }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Thinking level the caller asked for (`--thinking`), before clamping: a model switch carries it over. */
	requestedThinkingLevel?: ThinkingLevel;
	/** Resource loader for features, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside features */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [bash] */
	initialActiveToolNames?: string[];
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, a resumed session
	 * replaces them with the loadout its transcript records, with `defaultToolModifiers` applied, and
	 * reload activates tools newly added to the setting. Tools removed from it stay active.
	 */
	usesDefaultTools?: boolean;
	/**
	 * `+name`/`-name` entries applied on top of the `defaultTools` setting, from `--tools`. Reload
	 * applies them to the reloaded setting too, so a removed tool stays removed.
	 */
	defaultToolModifiers?: string[];
	/**
	 * Optional allowlist of tool names or patterns (`*` matches any characters). When provided, only
	 * matching tools are exposed, MCP tools included. An empty list exposes no tools.
	 */
	allowedToolNames?: string[];
	/** Optional denylist of tool names or patterns. When provided, matching tools are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current FeatureHost */
	featureHostRef?: { current?: FeatureHost };
	/** Session start event metadata emitted when features bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ModeBindingOptions {
	uiContext?: SessionUI;
	mode?: UiMode;
	commandContextActions?: CommandActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: FeatureErrorListener;
}

/** A message waiting in the steering or follow-up queue, as the session lists it. */
export interface QueuedInput {
	/** Stable handle for `replaceQueuedInput`, `removeQueuedInput` and `moveQueuedInput`; gone once delivery begins. */
	id: string;
	mode: "steer" | "followUp";
	text: string;
	/** Attachments (images) delivered with the text; edits keep them. */
	imageCount: number;
	source: InputSource;
	/** Taken out of delivery by `holdQueuedInput` while the user edits it; it keeps its place. */
	held?: true;
}
/** What `releaseQueuedInput` did with a held message. */
export type ReleasedQueuedInput =
	| { outcome: "queued" | "removed" | "missing" }
	/** No run is active, so the message cannot wait in the queue: it left the queue and the caller sends it. */
	| { outcome: "idle"; mode: "steer" | "followUp"; text: string; images: ImageContent[]; source: InputSource };
export type QueuedInputDisposition = "handled" | "queued";
/** Options for `steer()` and `followUp()`. */
export type QueuedInputOptions = Pick<PromptOptions, "source" | "attachImagePaths">;
export type PromptDisposition = QueuedInputDisposition | "started";

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch feature commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for feature input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/**
	 * Attach the image files the text names (absolute, `~/`, `./`, quoted or escaped paths, `file://` URLs) as images.
	 * Set by the terminal and /web for text the user typed; command lines are not scanned. Default: false.
	 */
	attachImagePaths?: boolean;
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched, and why a command it ran failed. Not called if the prompt is rejected. */
	preflightResult?: (disposition: PromptDisposition, commandFailure?: string) => void;
}

export interface ModelMutationOptions {
	/** Persist the new value as a default. Defaults to session-only. */
	persist?: boolean;
	/** Where `persist` writes a model default: the global settings (default) or this project's, which needs a trusted project. */
	scope?: "global" | "project";
}

export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface PendingUserInput {
	text: string;
	images?: ImageContent[];
	source: InputSource;
	expandedPaths?: Set<string>;
	/** Set when the input is not what its source implies: a held message released after a compaction is "queued". */
	origin?: InputOrigin;
}
