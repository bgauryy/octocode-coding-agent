/** The API passed to extension factory functions. */

import type { ThinkingLevel, EventBus } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ImageContent, Model, Provider, TextContent } from "@octocodeai/octocode-ai";
import type { KeyId } from "@octocodeai/octocode-tui";
import type { TSchema } from "typebox";
import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../../cache-warmer.ts";
import type { ExecOptions, ExecResult } from "../../exec.ts";
import type { McpServerConfig, RegisteredMcpServer } from "../../../../../mcp/src/servers.ts";
import type { CustomMessage } from "../../messages.ts";
import type { Settings } from "../../settings-manager.ts";
import type { SkillResourceSnapshot } from "../../skill-resource-snapshot.ts";
import type { SlashCommandInfo } from "../../slash-commands.ts";
import type * as AgentEvents from "./agent-events.ts";
import type { ExtensionContext } from "./context.ts";
import type {
	BeforeAgentStartEventResult,
	BeforeProviderRequestEventResult,
	ContextEventResult,
	MessageEndEventResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	ToolCallEventResult,
	ToolResultEventResult,
	UserBashEventResult,
} from "./events.ts";
import type {
	InputEvent,
	InputEventResult,
	ModelSelectEvent,
	ThinkingLevelSelectEvent,
	UserBashEvent,
	UserInputEvent,
	UserInputEventResult,
} from "./input-events.ts";
import type { ExtensionVirtualModel, ProviderConfig } from "./provider.ts";
import type { EntryRenderer, MarkdownTransformer, MessageRenderer, RegisteredCommand } from "./rendering.ts";
import type * as SessionEvents from "./session-events.ts";
import type { ToolCallEvent, ToolResultEvent } from "./tool-events.ts";
import type { ToolDefinition, ToolInfo, ToolRendererResolver } from "./tools.ts";

// ============================================================================
// Extension API
// ============================================================================

/** Handler function type for events */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * ExtensionAPI passed to extension factory functions.
 */
export interface ExtensionAPI {
	// =========================================================================
	// Event Subscription
	// =========================================================================

	on(event: "project_trust", handler: SessionEvents.ProjectTrustHandler): () => void;
	on(
		event: "resources_discover",
		handler: ExtensionHandler<SessionEvents.ResourcesDiscoverEvent, SessionEvents.ResourcesDiscoverResult>,
	): () => void;
	on(event: "session_start", handler: ExtensionHandler<SessionEvents.SessionStartEvent>): () => void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionEvents.SessionInfoChangedEvent>): () => void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionEvents.SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): () => void;
	on(
		event: "session_before_fork",
		handler: ExtensionHandler<SessionEvents.SessionBeforeForkEvent, SessionBeforeForkResult>,
	): () => void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionEvents.SessionBeforeCompactEvent, unknown>,
	): () => void;
	on(event: "session_compact", handler: ExtensionHandler<SessionEvents.SessionCompactEvent>): () => void;
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionEvents.SessionCompactFailedEvent>): () => void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionEvents.SessionShutdownEvent>): () => void;
	on(event: "mcp_servers_change", handler: ExtensionHandler<SessionEvents.McpServersChangeEvent>): () => void;
	on(
		event: "session_before_tree",
		handler: ExtensionHandler<SessionEvents.SessionBeforeTreeEvent, SessionBeforeTreeResult>,
	): () => void;
	on(event: "session_tree", handler: ExtensionHandler<SessionEvents.SessionTreeEvent>): () => void;
	on(event: "context", handler: ExtensionHandler<AgentEvents.ContextEvent, ContextEventResult>): () => void;
	on(
		event: "context_with_system",
		handler: ExtensionHandler<AgentEvents.ContextWithSystemEvent, ContextEventResult>,
	): () => void;
	on(
		event: "cache_warming_decision",
		handler: ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>,
	): () => void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<AgentEvents.BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): () => void;
	on(event: "before_provider_headers", handler: ExtensionHandler<AgentEvents.BeforeProviderHeadersEvent>): () => void;
	on(event: "after_provider_response", handler: ExtensionHandler<AgentEvents.AfterProviderResponseEvent>): () => void;
	on(event: "provider_stream_event", handler: ExtensionHandler<AgentEvents.ProviderStreamEvent>): () => void;
	on(
		event: "before_agent_start",
		handler: ExtensionHandler<AgentEvents.BeforeAgentStartEvent, BeforeAgentStartEventResult>,
	): () => void;
	on(event: "agent_start", handler: ExtensionHandler<AgentEvents.AgentStartEvent>): () => void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEvents.AgentEndEvent>): () => void;
	on(
		event: "agent_before_settle",
		handler: ExtensionHandler<AgentEvents.AgentBeforeSettleEvent, AgentEvents.BoundaryResult>,
	): () => void;
	on(event: "agent_interrupted", handler: ExtensionHandler<AgentEvents.AgentInterruptedEvent>): () => void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentEvents.AgentSettledEvent>): () => void;
	on(event: "ui_prompt_start", handler: ExtensionHandler<AgentEvents.UIPromptStartEvent>): () => void;
	on(event: "ui_prompt_end", handler: ExtensionHandler<AgentEvents.UIPromptEndEvent>): () => void;
	on(event: "turn_start", handler: ExtensionHandler<AgentEvents.TurnStartEvent>): () => void;
	on(event: "turn_end", handler: ExtensionHandler<AgentEvents.TurnEndEvent, AgentEvents.BoundaryResult>): () => void;
	on(event: "message_start", handler: ExtensionHandler<AgentEvents.MessageStartEvent>): () => void;
	on(event: "message_update", handler: ExtensionHandler<AgentEvents.MessageUpdateEvent>): () => void;
	on(event: "message_end", handler: ExtensionHandler<AgentEvents.MessageEndEvent, MessageEndEventResult>): () => void;
	on(event: "tool_execution_start", handler: ExtensionHandler<AgentEvents.ToolExecutionStartEvent>): () => void;
	on(event: "tool_execution_update", handler: ExtensionHandler<AgentEvents.ToolExecutionUpdateEvent>): () => void;
	on(event: "tool_execution_end", handler: ExtensionHandler<AgentEvents.ToolExecutionEndEvent>): () => void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): () => void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): () => void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;
	on(event: "user_input", handler: ExtensionHandler<UserInputEvent, UserInputEventResult>): () => void;

	// =========================================================================
	// Tool Registration
	// =========================================================================

	/** Register a tool that the LLM can call. */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	/** Register a catalog of tools with one registry refresh instead of one per tool; all are validated first. */
	registerTools<TDetails = unknown>(tools: readonly ToolDefinition<TSchema, TDetails>[]): void;

	// =========================================================================
	// Command, Shortcut, Flag Registration
	// =========================================================================

	/** Register a custom command. */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/** Register a keyboard shortcut. */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** Register a CLI flag. */
	registerFlag(
		name: string,
		options:
			| {
					description?: string;
					type: "boolean";
					default?: boolean;
			  }
			| {
					description?: string;
					type: "string";
					default?: string;
			  },
	): void;

	/** Get the value of a registered CLI flag. */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Message Rendering
	// =========================================================================

	/** Register a custom renderer for CustomMessageEntry. */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	/** Register a transformer for user and assistant Markdown before Octocode renders it in the interactive transcript. */
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	/** Register a custom renderer for CustomEntry. Custom entries do not participate in LLM context. */
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

	/** Choose how tool calls are drawn. Resolvers run in extension load order. */
	registerToolRenderer(resolver: ToolRendererResolver): void;

	// =========================================================================
	// Actions
	// =========================================================================

	/** Send a custom message. The runtime returns a promise so callers can observe asynchronous failure; it also reports errors for callers that do not await. */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void | Promise<void>;

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 * Set expandPromptTemplates to dispatch extension commands and expand skill commands and prompt templates.
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void;

	/** Append a custom entry to the session for state persistence (not sent to LLM). */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	/** Capture the current session before auxiliary requests; record each completed response once, including reported failed usage. */
	createUsageRecorder(kind: string): (message: AssistantMessage) => void;

	// =========================================================================
	// Session Metadata
	// =========================================================================

	/** Set the session display name (shown in session selector). */
	setSessionName(name: string): void;

	/** Get the current session name, if set. */
	getSessionName(): string | undefined;

	/** Set or clear a label on an entry. Labels are user-defined markers for bookmarking/navigation. */
	setLabel(entryId: string, label: string | undefined): void;

	/** Execute a shell command. */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Get the names of the active tools, which are the tools declared to the model. */
	getActiveTools(): string[];

	/** Get all configured tools with parameter schema, prompt guidelines, exposure, and source metadata. */
	getAllTools(): ToolInfo[];

	/** Get a copy of the effective settings (global and project settings merged, with overrides). */
	getSettings(): Settings;

	/** Set the active tools by name. Unknown and `hidden` tools are ignored. */
	setActiveTools(toolNames: string[]): void;
	/** Whether the tool selection (`--tools`, `--exclude-tools`, `defaultTools`) can activate tools named `<prefix>…` that register with `defaultActive` = `activeByDefault`; a source whose tools it cannot activate need not start. */
	selectsTools(prefix: string, activeByDefault: boolean): boolean;

	/** Get available slash commands in the current session. */
	getCommands(): SlashCommandInfo[];

	/** Get canonical reference directories for loaded skills, independent of slash-command visibility. */
	getSkillDirectories(): string[];
	/** Capture accepted skill resources after runtime initialization. Omit names for all; command names select a subset; [] is empty. No discovery or plugin activation. */
	getSkillResourceSnapshot(names?: readonly string[]): SkillResourceSnapshot;

	// =========================================================================
	// Model and Thinking Level
	// =========================================================================

	/**
	 * Set the model for the current session without changing the configured default for new sessions.
	 * Returns false if authentication is not configured for the model's provider.
	 */
	setModel(model: Model<any>): Promise<boolean>;

	/** Get current thinking level. */
	getThinkingLevel(): ThinkingLevel;

	/**
	 * Set the thinking level (clamped to model capabilities) for the current session without changing the configured default
	 * for new sessions.
	 * @deprecated No native feature calls it; it may be removed in a future release.
	 */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// Provider Registration
	// =========================================================================

	/**
	 * Register or override a model provider.
	 *
	 * If `models` is provided: replaces all existing models for this provider.
	 * If only `baseUrl` is provided: overrides the URL for existing models.
	 * If `oauth` is provided: registers OAuth provider for /login support.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 *
	 * During initial extension load this call is queued and applied once the
	 * runner has bound its context. After that it takes effect immediately, so
	 * it is safe to call from command handlers or event callbacks without
	 * requiring a `/reload`.
	 *
	 * @example
	 * // Register a new provider with custom models
	 * api.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "$PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * api.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // Register provider with OAuth support
	 * api.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes all models belonging to the named provider and restores any
	 * built-in models that were overridden by it. Has no effect if the provider
	 * is not currently registered.
	 *
	 * Like `registerProvider`, this takes effect immediately when called after
	 * the initial load phase.
	 *
	 * @example
	 * api.unregisterProvider("my-proxy");
	 */
	unregisterProvider(name: string): void;

	// =========================================================================
	// MCP Servers
	// =========================================================================

	/**
	 * Register an MCP server for this session, with the same config as an `mcpServers` entry in
	 * `mcp.json`. The server connects next to the configured servers: on `session_start` when
	 * registered during extension load, right away when registered later. Registering a name again
	 * replaces the extension's earlier registration.
	 *
	 * The registration is not saved; register again on every load. A server of the same name in
	 * `mcp.json` takes precedence. Throws for invalid configs and for names another extension
	 * registered. When no loaded extension handles MCP servers (for example because another MCP
	 * extension replaced the built-in one), the registration is reported as an extension error.
	 *
	 * @example
	 * api.registerMcpServer("jira", { url: "https://mcp.example.com/jira" });
	 */
	registerMcpServer(name: string, config: McpServerConfig): void;

	/** Remove an MCP server this extension registered and close its connection. */
	unregisterMcpServer(name: string): void;

	/** Every MCP server registered by extensions. For extensions that connect MCP servers. */
	getMcpServers(): RegisteredMcpServer[];

	/**
	 * Register a virtual model: a selectable catalog entry that routes each request to a physical
	 * model. The selection (`ctx.model`, `model_change` entries) names the virtual model; assistant
	 * messages record the physical model and thinking level the router picked.
	 *
	 * `provider` may be any provider id, including one with physical models, and may list several
	 * virtual models. Registering the same provider and id again replaces the virtual model. See
	 * docs/virtual-models.md.
	 */
	registerVirtualModel<TState = unknown>(model: ExtensionVirtualModel<TState>): void;

	/**
	 * Remove a virtual model registered with `registerVirtualModel()`.
	 * @deprecated No native feature calls it; it may be removed in a future release.
	 */
	unregisterVirtualModel(provider: string, id: string): void;

	/** Shared event bus for extension communication. */
	events: EventBus;
}
