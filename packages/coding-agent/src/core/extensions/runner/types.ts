/** Types shared by the extension runner and the parts it delegates to. */

import type { AgentTool } from "@octocodeai/octocode-agent-core";
import type { Model, Provider } from "@octocodeai/octocode-ai";
import type { NativeCompactionResult } from "../../compaction/native-result.ts";
import type { ModelRegistry } from "../../model-registry.ts";
import type { ScopedModel } from "../../model-resolver.ts";
import type { SessionManager } from "../../session-manager.ts";
import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../../system-prompt.ts";
import type { VirtualModelDefinition } from "../../virtual-models.ts";
import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartCustomEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeAgentStartUserEvent,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BoundaryContextPreview,
	CacheWarmingDecisionEvent,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	ContextWithSystemEvent,
	Extension,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionUIContext,
	InputEvent,
	MessageEndEvent,
	ProjectTrustEvent,
	ProviderConfig,
	ReplacedSessionContext,
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
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| ContextWithSystemEvent
	| CacheWarmingDecisionEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
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
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

export type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| NativeCompactionResult
	| SessionBeforeTreeResult;

export type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? NativeCompactionResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type BoundaryBaseEvent =
	| Omit<TurnEndEvent, "entries" | "continue" | "context">
	| Omit<AgentBeforeSettleEvent, "entries" | "continue" | "context">;

export interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/** Provider registration actions a mode may supply to `bindCore()`; the model registry is the fallback. */
export interface RunnerProviderActions {
	registerProvider?: (name: string, config: ProviderConfig) => void;
	registerNativeProvider?: (provider: Provider) => void;
	unregisterProvider?: (name: string) => void;
	registerVirtualModel?: (definition: VirtualModelDefinition) => void;
	unregisterVirtualModel?: (provider: string, id: string) => void;
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
	abortFn: (reason?: "interrupted" | "internal") => void;
	hasPendingMessagesFn: () => boolean;
	getContextUsageFn: () => ContextUsage | undefined;
	compactFn: (options?: CompactOptions) => void;
	getSystemPromptFn: () => string;
	getSystemPromptOptionsFn: () => BuildSystemPromptOptions;
	executeToolFn: ExtensionContextActions["executeTool"];
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
	readonly extensions: Extension[];
	readonly runtime: ExtensionRuntime;
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly modelRegistry: ModelRegistry;
	readonly uiContext: ExtensionUIContext;
	readonly mode: ExtensionMode;
	readonly bindings: RunnerBindings;
	hasUI(): boolean;
	assertActive(): void;
	createContext(): ExtensionContext;
	emit(event: RunnerEmitEvent): Promise<unknown>;
	emitError(error: ExtensionError): void;
	reportUnhandledMcpServers(): void;
}
