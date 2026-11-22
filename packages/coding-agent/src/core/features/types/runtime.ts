/** Loaded features, their registrations and the shared runtime. */

import type { AgentTool, AgentToolCallOutcome, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ImageContent, Model, Provider, TextContent, Usage } from "@octocodeai/octocode-ai";
import type { McpServerChange, RegisteredMcpServer } from "@octocodeai/octocode-contracts/mcp-server";
import type { CustomMessage } from "../../messages.ts";
import type { ScopedModel } from "../../model-resolver.ts";
import type { SessionEntry, SessionManager, SessionNameSource } from "../../session-manager.ts";
import type { Settings } from "../../settings-manager.ts";
import type { SkillResourceSnapshot } from "../../skill-resource-snapshot.ts";
import type { SlashCommandInfo } from "../../slash-commands.ts";
import type { FeatureOwner, SourceInfo } from "../../source-info.ts";
import type { BuildSystemPromptOptions } from "../../system-prompt.ts";
import type { FeatureSetup } from "./api.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExecuteToolOptions,
	FeatureContext,
	ReplacedSessionContext,
} from "./context.ts";
import type { ProviderConfig } from "./provider.ts";
import type { EntryRenderer, MessageRenderer, RegisteredCommand } from "./rendering.ts";
import type { ToolDefinition, ToolInfo, ToolRendererResolver } from "./tools.ts";

/** Feature factory function type. Supports both sync and async initialization. */
export type FeatureRegister = (api: FeatureSetup) => void | Promise<void>;

/**
 * A feature the host registers directly: no module is loaded. `native` is the Octocode feature set and `builtin` is
 * every other feature the host supplies (llama.cpp, MCP, plugin MCP servers, and injected features in tests).
 */
export interface Feature {
	/** Names the feature in diagnostics and as `<inline:id>` or `builtin:id` in its source path. */
	readonly id: string;
	readonly owner: FeatureOwner;
	/** Omit this feature from the startup feature list. */
	readonly hidden?: boolean;
	/** The source path, when it is not `builtin:<id>` (native) or `<inline:<id>>`. */
	readonly path?: string;
	register: FeatureRegister;
}

/** The servers features registered with `api.mcpServers.register()`; the MCP workspace's `McpServerRegistry` implements it. */
interface McpServerStore {
	validate(changes: readonly McpServerChange[]): void;
	/** Revalidate against the current store before publishing the whole batch. */
	apply(changes: readonly McpServerChange[]): void;
	register(server: RegisteredMcpServer): void;
	get(name: string): RegisteredMcpServer | undefined;
	/** Copies of the registered servers, in registration order. */
	list(): RegisteredMcpServer[];
	/** Called after every change. */
	setChangeListener(listener: (() => void) | undefined): void;
}

// Loaded Feature Types
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

type HandlerFn = (...args: unknown[]) => unknown;

type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; together?: boolean },
) => void | Promise<void>;

type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
) => void;

type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

type SetSessionNameHandler = (name: string, source?: SessionNameSource) => void;

type GetSessionNameHandler = () => string | undefined;

type GetActiveToolsHandler = () => string[];

type GetAllToolsHandler = () => ToolInfo[];

type GetSettingsHandler = () => Settings;

type GetCommandsHandler = () => SlashCommandInfo[];

/** `boundary`: the change is a feature's own, so held tools do not defer it (set for every owner but `native`). */
type SetActiveToolsHandler = (toolNames: string[], options?: { boundary?: boolean }) => void;

type RefreshToolsHandler = () => void;

type SetModelHandler = (model: Model<any>) => Promise<boolean>;

type GetThinkingLevelHandler = () => ThinkingLevel;

type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * Shared state created by loader, used during registration and runtime.
 */
interface FeatureRuntimeState {
	/** Legacy provider-config registrations queued during feature loading, processed when runner binds. */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; source: string }>;
	/** Native octocode-ai provider registrations queued during feature loading, processed when runner binds. */
	pendingNativeProviderRegistrations: Array<{ provider: Provider; source: string }>;
	/** Create a feature context. Throws before the runner binds. */
	createContext: () => FeatureContext;
	createUsageRecorder: (kind: string) => (message: AssistantMessage) => void;
	recordUsage: (kind: string, provider: string, model: string, usage: Usage) => void;
	/** Throws when this feature instance is stale after runtime replacement. */
	assertActive: () => void;
	/** Marks this feature instance as stale after runtime replacement or reload. */
	invalidate: (message?: string) => void;
	/** Retain an event-bus subscription until this runtime is invalidated. */
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	/**
	 * Register a provider.
	 *
	 * Before bindCore(): queues registrations.
	 * After bindCore(): calls ModelRegistry directly for immediate effect.
	 */
	registerProvider: (name: string, config: ProviderConfig, source?: string) => void;
	registerNativeProvider: (provider: Provider, source?: string) => void;
	/** Servers registered with `api.mcpServers.register()`. */
	mcpServers: McpServerStore;
}

/**
 * Action implementations for FeatureSetup methods.
 * Provided to runner.initialize(), copied into the shared runtime.
 */
export interface SessionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getHiddenDeclarations: () => string[];
	getAllTools: GetAllToolsHandler;
	getSettings: GetSettingsHandler;
	setActiveTools: SetActiveToolsHandler;
	selectsTools: (prefix: string, activeByDefault: boolean) => boolean;
	setToolPolicy?: (allows: (name: string) => boolean) => void;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	getSkillDirectories: () => string[];
	getSkillResourceSnapshot: (names?: readonly string[]) => SkillResourceSnapshot;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
}

/**
 * Actions for FeatureContext (ctx.* in event handlers).
 * Required by all modes.
 */
export interface ContextActions {
	onUsageRecorded?: (entry: Extract<SessionEntry, { type: "usage" }>) => void;
	getExplicitToolNames?: () => readonly string[];
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	isIdle: () => boolean;
	isProjectTrusted: () => boolean;
	getSignal: () => AbortSignal | undefined;
	getTurnId?: () => string | undefined;
	abort: (reason?: "interrupted" | "peer" | "internal") => void;
	failRun?: (reason: string) => void;
	hasPendingMessages: () => boolean;
	isMessageQueued: (details: object) => boolean;
	replaceQueuedMessage?: (details: object, content: string) => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
	/** Backs `ToolContext.executeTool()`. Without it, nested calls fail. */
	executeTool?: (
		callerId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	) => Promise<AgentToolCallOutcome>;
	/** Backs `ToolContext.tools`. */
	getCallableTools?: () => readonly AgentTool[];
}

export type NewSessionHandler = (options?: {
	parentSession?: string;
	cwd?: string;
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

/**
 * Actions for CommandContext (ctx.* in command handlers).
 * Only needed for interactive mode where feature commands are invokable.
 */
export interface CommandActions {
	waitForIdle: () => Promise<void>;
	newSession: NewSessionHandler;
	fork: ForkHandler;
	navigateTree: NavigateTreeHandler;
	switchSession: SwitchSessionHandler;
	reload: ReloadHandler;
}

/**
 * Full runtime = state + actions.
 * Created by loader with throwing action stubs, completed by runner.initialize().
 */
export interface FeatureRuntime extends FeatureRuntimeState, SessionActions {}

/** Loaded feature with all registered items. */
export interface FeatureRecord {
	/** Names the feature: `<inline:id>` for the native feature and injected ones, `builtin:id` for built-ins. */
	path: string;
	id: string;
	owner: FeatureOwner;
	hidden?: boolean;
	sourceInfo: SourceInfo;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	toolRenderers?: ToolRendererResolver[];
	entryRenderers?: Map<string, EntryRenderer>;
	commands: Map<string, RegisteredCommand>;
}

/** A file the loader skipped without failing the session. */
export interface LoadWarning {
	path: string;
	warning: string;
	/** The startup listing and `/harness config` already show this file as not loaded, so a screen that has them skips this warning. */
	listedInContext?: boolean;
}

/** The registered features, their diagnostics and the shared runtime. */
export interface LoadedFeatures {
	features: FeatureRecord[];
	errors: Array<{ path: string; error: string }>;
	warnings?: LoadWarning[];
	/** Shared runtime - actions are throwing stubs until runner.initialize() */
	runtime: FeatureRuntime;
}

// Feature Error
// ============================================================================

export interface FeatureError {
	source: string;
	event: string;
	error: string;
	stack?: string;
}
