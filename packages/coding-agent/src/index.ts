export type { ContextReport, ContextContributor } from "./core/agent-session/context-report.ts";
export type { ManualCompactionOptions } from "./core/compaction/manual-options.ts";
export type { PlanOptions, PlanState } from "./octocode/plan/state.ts";
export type { RepositoryDiff } from "./octocode/files/repository-diff.ts";
// Core session management

export { type Args, parseArgs } from "./cli/args.ts";

// Config paths
export {
	CONFIG_DIR_NAME,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getPackageDir,
	getReadmePath,
	VERSION,
} from "./config.ts";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionStats,
} from "./core/agent-session.ts";
export { readStoredCredential } from "./core/auth-storage.ts";
export type { CacheWarmingDecision, CacheWarmingStatus } from "./core/cache-warmer.ts";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactionResult,
	type CutPointResult,
	collectEntriesForBranchSummary,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	findCutPoint,
	findTurnStartIndex,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareBranchEntries,
	serializeConversation,
	shouldCompact,
} from "./core/compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
// Extension system
export type * from "./index/extension-types.ts";
export {
	createExtensionRuntime,
	defineTool,
	discoverAndLoadExtensions,
	ExtensionRunner,
	isBashToolResult,
	isToolCallEventType,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "./core/extensions/index.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { FooterData, ReadonlyFooterDataProvider, StatusEntry, StatusTone } from "./core/footer-data-provider.ts";
export type { RegisteredMcpServer } from "../../mcp/src/servers.ts";
export { convertToLlm } from "./core/messages.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export {
	type ModelScopeDiagnostic,
	type ResolveCliModelResult,
	type ResolveModelScopeResult,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	type ScopedModel,
} from "./core/model-resolver.ts";
export {
	type CreateModelRuntimeOptions,
	CredentialSynchronizationError,
	type CredentialSynchronizationOperation,
	ModelRuntime,
	type ModelRuntimeAuthOverrides,
	type ModelRuntimeLoginOptions,
} from "./core/model-runtime.ts";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
export type { ResourceCollision, ResourceDiagnostic, ResourceLoader } from "./core/resource-loader.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
// SDK for programmatic usage
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "./core/agent-session-runtime.ts";
export type { PromptTemplate } from "./core/prompt-templates.ts";
export { createAgentSession } from "./core/sdk.ts";
export type { CreateAgentSessionOptions, CreateAgentSessionResult } from "./core/sdk/types.ts";
export {
	type BranchSummaryEntry,
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	type CompactionEntry,
	type ContextEditableContent,
	type ContextEditEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getLatestCompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	type ProjectedSessionEntry,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	SessionManager,
	type SessionMessageEntry,
	type SessionProjection,
	type SessionTreeNode,
	sessionEntryToContextMessages,
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.ts";
export {
	type CacheWarmingMode,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type ImageSettings,
	type PackageSource,
	type QuietStartup,
	type RetrySettings,
	SettingsManager,
	type SettingsManagerCreateOptions,
	type TuiMode,
} from "./core/settings-manager.ts";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	type ExplicitSkill,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
export { type EditDiffResult, generateDiffString, generateUnifiedPatch } from "./core/tools/edit-diff.ts";
// Tools
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ToolsOptions,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	withFileMutationQueue,
} from "./core/tools/index.ts";
export {
	hasTrustRequiringProjectResources,
	type ProjectTrustDecision,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
	type ProjectTrustUpdate,
} from "./core/trust-manager.ts";
export {
	type ModelRoute,
	type ModelRouteReason,
	type ModelRouteRequest,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelDefinition,
	type VirtualModelStateData,
} from "./core/virtual-models.ts";
// Built-in extensions. The CLI loads them; SDK sessions add them to their extension factories.
export type { LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry } from "../../mcp/src/config.ts";
export { createMcpExtension, type McpExtensionOptions, type McpTransportFactory } from "../../mcp/src/index.ts";
export type { McpServerPreset } from "../../mcp/src/preset.ts";
export { octocodePreset } from "../../mcp/src/presets/octocode/index.ts";
// Main entry point
export { type MainOptions, main } from "./main.ts";
// Run modes for programmatic SDK usage
export {
	InteractiveMode,
	type InteractiveModeOptions,
	type JsonAgentSessionEvent,
	type ModelInfo,
	type PrintModeOptions,
	RpcClient,
	type RpcClientOptions,
	type RpcCommand,
	type RpcEvent,
	type RpcEventListener,
	type RpcExtensionUIDismiss,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	type RpcSessionState,
	runPrintMode,
	runRpcMode,
} from "./modes/index.ts";
// UI components for extensions
export {
	AssistantMessageComponent,
	BashExecutionComponent,
	BorderedLoader,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	type CustomEditorOptions,
	CustomMessageComponent,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	FooterComponent,
	keyHint,
	keyText,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	type RenderDiffOptions,
	rawKeyHint,
	renderDiff,
	SessionSelectorComponent,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
	// @deprecated: removed in the next release.
	ShowImagesSelectorComponent,
	SkillInvocationMessageComponent,
	// @deprecated: removed in the next release.
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	TreeSelectorComponent,
	truncateToVisualLines,
	UserMessageComponent,
	UserMessageSelectorComponent,
	type VisualTruncateResult,
} from "./modes/interactive/components/index.ts";
// Theme utilities for custom tools and extensions
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeAppearance,
	type ThemeBg,
	type ThemeColor,
	type ThemeStyle,
	type ThemeToken,
} from "./theme/theme.ts";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
export { convertToPng } from "./utils/image-convert.ts";
export { formatDimensionNote, type ResizedImage, resizeImage } from "./utils/image-resize.ts";
export { detectSupportedImageMimeTypeFromFile } from "./utils/mime.ts";
// Shell utilities
export { getPowerShellConfig, getShellConfig } from "./utils/shell.ts";

export type { SkillResourceSnapshot } from "./core/skill-resource-snapshot.ts";

export { ApplicationService, getApplicationPort, getApplicationPortForSession } from "./core/application/index.ts";
export type { ApplicationStateSource } from "./core/application/index.ts";
