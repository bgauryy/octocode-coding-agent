/**
 * Extension system for lifecycle events and custom tools.
 */

export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.ts";
export type { SourceInfo } from "../source-info.ts";
export { createExtensionRuntime, discoverAndLoadExtensions } from "./loader.ts";
export type { ExtensionErrorListener, ShutdownHandler } from "./runner.ts";
export { ExtensionRunner } from "./runner.ts";
export type {
	AfterProviderResponseEvent,
	AgentActivityOutcome,
	AgentBeforeSettleEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentInterruptedEvent,
	AgentStartEvent,
	// Re-exports
	AgentToolResult,
	AgentToolUpdateCallback,
	// App keybindings (for custom editors)
	AppKeybinding,
	AutocompleteProviderFactory,
	// Events - Tool (ToolCallEvent types)
	BashToolCallEvent,
	BashToolResultEvent,
	BeforeAgentStartCustomEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeAgentStartUserEvent,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BoundaryContextPreview,
	BoundaryResult,
	BoundaryState,
	BuildSystemPromptOptions,
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	// Context
	CompactOptions,
	ContextEditEntryDraft,
	// Events - Agent
	ContextEvent,
	// Event Results
	ContextEventResult,
	ContextUsage,
	ContextWithSystemEvent,
	CustomEntryDraft,
	CustomMessageEntryDraft,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditorFactory,
	// Message and Entry Rendering
	EntryRenderer,
	EntryRenderOptions,
	ExecOptions,
	ExecResult,
	ExecuteToolOptions,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// Errors
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionMode,
	// Runtime
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionToolContext,
	ToolInvocation,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUIPermissionRequest,
	ExtensionVirtualModel,
	ExtensionWidgetOptions,
	InlineExtension,
	// Events - Input
	InputEvent,
	InputEventResult,
	UserInputEvent,
	UserInputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	MarkdownTransformContext,
	MarkdownTransformer,
	McpServersChangeEvent,
	// Events - Message
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	NormalizedBuildSystemPromptOptions,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	// Provider Registration
	ProviderConfig,
	ProviderModelConfig,
	ProviderStreamEvent,
	// Commands
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	// Events - Resources
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionBoundaryDraft,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	// Events - Session
	SessionStartEvent,
	SessionTreeEvent,
	TerminalInputHandler,
	ThinkingLevelSelectEvent,
	ToolAnnotations,
	// Events - Tool
	ToolCallEvent,
	ToolCallEventResult,
	// Tools
	ToolDefinition,
	// Events - Tool Execution
	ToolExecutionEndEvent,
	// Tool execution mode
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolExposure,
	ToolInfo,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
	ToolRendererResolver,
	ToolRenderers,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptKind,
	UIPromptStartEvent,
	// Events - User Bash
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
} from "./types.ts";
// Type guards
export { defineTool, isBashToolResult, isToolCallEventType } from "./types.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";
