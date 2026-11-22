import type { SessionBus } from "../bus/session-bus.ts";
/** Types shared by the feature runner and the parts it delegates to. */

import type { AgentTool } from "@octocodeai/octocode-agent-core";
import type { Model, Provider } from "@octocodeai/octocode-ai";
import type { NativeCompactionResult } from "../../compaction/native-result.ts";
import type { ModelRegistry } from "../../model-registry.ts";
import type { ScopedModel } from "../../model-resolver.ts";
import type { SessionManager } from "../../session-manager.ts";
import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../../system-prompt.ts";
import type {
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	SwitchSessionHandler,
} from "../types/runtime.ts";
import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartCustomEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeAgentStartUserEvent,
	BoundaryContextPreview,
	CacheWarmingDecisionEvent,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	FeatureRecord,
	FeatureContext,
	ContextActions,
	FeatureError,
	FeatureEvent,
	UiMode,
	FeatureRuntime,
	SessionUI,
	InputEvent,
	MessageEndEvent,
	ProviderConfig,
	ResourcesDiscoverEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionBoundaryDraft,
	ToolCallEvent,
	ToolResultEvent,
	TurnEndEvent,
	UserBashEvent,
	UserInputEvent,
} from "../types.ts";

/** The message that starts a run: the before_agent_start event without its prompt fields. */
export type BeforeAgentStartTrigger =
	| Pick<BeforeAgentStartUserEvent, "messageType" | "prompt" | "images">
	| Pick<BeforeAgentStartCustomEvent, "messageType" | "message">;

/** Combined result from all before_agent_start handlers. */
export interface BeforeAgentStartCombinedResult {
	messages: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
export type RunnerEmitEvent = Exclude<
	FeatureEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| CacheWarmingDecisionEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
	| UserInputEvent
	| TurnEndEvent
	| AgentBeforeSettleEvent
>;

export type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{
		type:
			| "session_before_switch"
			| "session_before_fork"
			| "session_before_quit"
			| "session_before_compact"
			| "session_before_tree";
	}
>;

export type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| NativeCompactionResult
	| SessionBeforeTreeResult;

export type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends {
	type: "session_before_switch" | "session_before_quit";
}
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? NativeCompactionResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type FeatureErrorListener = (error: FeatureError) => void;

export type BoundaryBaseEvent =
	| Omit<TurnEndEvent, "entries" | "continue" | "context">
	| Omit<AgentBeforeSettleEvent, "entries" | "continue" | "context">;

export interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

export type ShutdownHandler = () => void;

/** Provider registration actions a mode may supply to `bindCore()`; the model registry is the fallback. */
export interface RunnerProviderActions {
	registerProvider?: (name: string, config: ProviderConfig) => void;
	registerNativeProvider?: (provider: Provider) => void;
}

/** Callbacks bound by `bindCore()` and `bindCommandContext()`. Contexts read them at call time. */
export interface RunnerBindings {
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	getExplicitToolNames: () => readonly string[];
	isIdleFn: () => boolean;
	isProjectTrustedFn: () => boolean;
	getTurnIdFn: () => string | undefined;
	getSignalFn: () => AbortSignal | undefined;
	waitForIdleFn: () => Promise<void>;
	abortFn: (reason?: "interrupted" | "peer" | "internal") => void;
	failRunFn: (reason: string) => void;
	hasPendingMessagesFn: () => boolean;
	isMessageQueuedFn: (details: object) => boolean;
	replaceQueuedMessageFn: (details: object, content: string) => boolean;
	getContextUsageFn: () => ContextUsage | undefined;
	compactFn: (options?: CompactOptions) => void;
	getSystemPromptFn: () => string;
	getSystemPromptOptionsFn: () => BuildSystemPromptOptions;
	executeToolFn: ContextActions["executeTool"];
	getCallableToolsFn: () => readonly AgentTool[];
	newSessionHandler: NewSessionHandler;
	forkHandler: ForkHandler;
	navigateTreeHandler: NavigateTreeHandler;
	switchSessionHandler: SwitchSessionHandler;
	reloadHandler: ReloadHandler;
	shutdownHandler: ShutdownHandler;
}

/** The runner as its delegated parts see it: its state, read at access time, and the methods they call back. */
export interface RunnerHost {
	readonly features: FeatureRecord[];
	/** The session's subscriptions, which every dispatch reads. */
	readonly bus: SessionBus;
	readonly runtime: FeatureRuntime;
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly modelRegistry: ModelRegistry;
	readonly uiContext: SessionUI;
	readonly mode: UiMode;
	readonly bindings: RunnerBindings;
	hasUI(): boolean;
	assertActive(): void;
	createContext(): FeatureContext;
	emit(event: RunnerEmitEvent): Promise<unknown>;
	emitError(error: FeatureError): void;
	reportUnhandledMcpServers(): void;
}
