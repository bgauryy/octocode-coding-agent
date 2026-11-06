/** Loaded extensions, their registrations and the shared runtime. */

import type { AgentTool, AgentToolCallOutcome, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ImageContent, Model, Provider, TextContent } from "@octocodeai/octocode-ai";
import type { KeyId } from "@octocodeai/octocode-tui";
import type { McpServerRegistry } from "../../../../../mcp/src/servers.ts";
import type { CustomMessage } from "../../messages.ts";
import type { ScopedModel } from "../../model-resolver.ts";
import type { SessionEntry, SessionManager, SessionNameSource } from "../../session-manager.ts";
import type { Settings } from "../../settings-manager.ts";
import type { SkillResourceSnapshot } from "../../skill-resource-snapshot.ts";
import type { SlashCommandInfo } from "../../slash-commands.ts";
import type { FeatureOwner, SourceInfo } from "../../source-info.ts";
import type { BuildSystemPromptOptions } from "../../system-prompt.ts";
import type { VirtualModelDefinition } from "../../virtual-models.ts";
import type { ExtensionAPI } from "./api.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExecuteToolOptions,
	ExtensionContext,
	ReplacedSessionContext,
} from "./context.ts";
import type { ProviderConfig } from "./provider.ts";
import type { EntryRenderer, MarkdownTransformer, MessageRenderer, RegisteredCommand } from "./rendering.ts";
import type { ToolDefinition, ToolInfo, ToolRendererResolver } from "./tools.ts";

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

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
	register: ExtensionFactory;
}

/** A feature supplied through `extensionFactories`: a bare factory, or one with a name and visibility. */
export type InlineExtension =
	| ExtensionFactory
	| {
			/** Display name shown as `<inline:name>` in the startup list and errors. */
			name: string;
			factory: ExtensionFactory;
			/** Omit this feature from the startup list. */
			hidden?: boolean;
	  };

// ============================================================================
// Loaded Extension Types
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

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

type SetActiveToolsHandler = (toolNames: string[]) => void;

type RefreshToolsHandler = () => void;

type SetModelHandler = (model: Model<any>) => Promise<boolean>;

type GetThinkingLevelHandler = () => ThinkingLevel;

type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * Shared state created by loader, used during registration and runtime.
 */
interface ExtensionRuntimeState {
	/** Legacy provider-config registrations queued during extension loading, processed when runner binds. */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	/** Native octocode-ai provider registrations queued during extension loading, processed when runner binds. */
	pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
	/** Virtual model registrations queued during extension loading, processed when runner binds. */
	pendingVirtualModelRegistrations: Array<{ definition: VirtualModelDefinition; extensionPath: string }>;
	/** Create an extension context. Throws before the runner binds. */
	createContext: () => ExtensionContext;
	createUsageRecorder: (kind: string) => (message: AssistantMessage) => void;
	/** Throws when this extension instance is stale after runtime replacement. */
	assertActive: () => void;
	/** Marks this extension instance as stale after runtime replacement or reload. */
	invalidate: (message?: string) => void;
	/** Retain an event-bus subscription until this runtime is invalidated. */
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	/**
	 * Register or unregister a provider.
	 *
	 * Before bindCore(): queues registrations / removes from queue.
	 * After bindCore(): calls ModelRegistry directly for immediate effect.
	 */
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	registerNativeProvider: (provider: Provider, extensionPath?: string) => void;
	unregisterProvider: (name: string, extensionPath?: string) => void;
	/** Servers registered with `api.registerMcpServer()`. */
	mcpServers: McpServerRegistry;
	registerVirtualModel: (definition: VirtualModelDefinition, extensionPath?: string) => void;
	unregisterVirtualModel: (provider: string, id: string) => void;
}

/**
 * Action implementations for ExtensionAPI methods.
 * Provided to runner.initialize(), copied into the shared runtime.
 */
export interface ExtensionActions {
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
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * Actions for ExtensionContext (ctx.* in event handlers).
 * Required by all modes.
 */
export interface ExtensionContextActions {
	onUsageRecorded?: (entry: Extract<SessionEntry, { type: "usage" }>) => void;
	getExplicitToolNames?: () => readonly string[];
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	isIdle: () => boolean;
	isProjectTrusted: () => boolean;
	getSignal: () => AbortSignal | undefined;
	getTurnId?: () => string | undefined;
	abort: (reason?: "interrupted" | "internal") => void;
	failRun?: (reason: string) => void;
	hasPendingMessages: () => boolean;
	isMessageQueued: (details: object) => boolean;
	replaceQueuedMessage?: (details: object, content: string) => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
	/** Backs `ExtensionToolContext.executeTool()`. Without it, nested calls fail. */
	executeTool?: (
		callerId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	) => Promise<AgentToolCallOutcome>;
	/** Backs `ExtensionToolContext.tools`. */
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
 * Actions for ExtensionCommandContext (ctx.* in command handlers).
 * Only needed for interactive mode where extension commands are invokable.
 */
export interface ExtensionCommandContextActions {
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
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** Loaded extension with all registered items. */
export interface Extension {
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
	markdownTransformer?: MarkdownTransformer;
	entryRenderers?: Map<string, EntryRenderer>;
	commands: Map<string, RegisteredCommand>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** A file the loader skipped without failing the session. */
export interface LoadWarning {
	path: string;
	warning: string;
	/** The startup listing and `/harness config` already show this file as not loaded, so a screen that has them skips this warning. */
	listedInContext?: boolean;
}

/** The registered features, their diagnostics and the shared runtime. */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	warnings?: LoadWarning[];
	/** Shared runtime - actions are throwing stubs until runner.initialize() */
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
