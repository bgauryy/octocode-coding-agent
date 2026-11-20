/** What a feature may do while it is composed (`FeatureSetup`) and its slices. */

import type { ThinkingLevel, EventBus } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ImageContent, Model, Provider, TextContent, Usage } from "@octocodeai/octocode-ai";
import type { TSchema } from "typebox";
import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../../cache-warmer.ts";
import type { McpServerConfig, RegisteredMcpServer } from "@octocodeai/octocode-contracts/mcp-server";
import type { CustomMessage } from "../../messages.ts";
import type { Settings } from "../../settings-manager.ts";
import type { SkillResourceSnapshot } from "../../skill-resource-snapshot.ts";
import type { SlashCommandInfo } from "../../slash-commands.ts";
import type * as AgentEvents from "./agent-events.ts";
import type { FeatureContext } from "./context.ts";
import type {
	BeforeAgentStartEventResult,
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
import type { ProviderConfig } from "./provider.ts";
import type { EntryRenderer, MessageRenderer, RegisteredCommand } from "./rendering.ts";
import type * as SessionEvents from "./session-events.ts";
import type { ToolCallEvent, ToolResultEvent } from "./tool-events.ts";
import type { ToolDefinition, ToolInfo, ToolRendererResolver } from "./tools.ts";
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
type FeatureHandler<E, R = undefined> = (event: E, ctx: FeatureContext) => Promise<R | void> | R | void;

/** Subscribes a feature's handlers to session events; each `on()` returns the function that removes it. */
export interface BusSubscriber {
	on(
		event: "resources_discover",
		handler: FeatureHandler<SessionEvents.ResourcesDiscoverEvent, SessionEvents.ResourcesDiscoverResult>,
	): () => void;
	on(event: "session_start", handler: FeatureHandler<SessionEvents.SessionStartEvent>): () => void;
	on(event: "session_info_changed", handler: FeatureHandler<SessionEvents.SessionInfoChangedEvent>): () => void;
	on(event: "session_context_changed", handler: FeatureHandler<SessionEvents.SessionContextChangedEvent>): () => void;
	on(
		event: "session_before_switch",
		handler: FeatureHandler<SessionEvents.SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): () => void;
	on(
		event: "session_before_fork",
		handler: FeatureHandler<SessionEvents.SessionBeforeForkEvent, SessionBeforeForkResult>,
	): () => void;
	on(
		event: "session_before_quit",
		handler: FeatureHandler<SessionEvents.SessionBeforeQuitEvent, SessionBeforeSwitchResult>,
	): () => void;
	on(
		event: "session_before_compact",
		handler: FeatureHandler<SessionEvents.SessionBeforeCompactEvent, unknown>,
	): () => void;
	on(event: "session_compact_prewarm", handler: FeatureHandler<SessionEvents.SessionCompactPrewarmEvent>): () => void;
	on(event: "session_compact", handler: FeatureHandler<SessionEvents.SessionCompactEvent>): () => void;
	on(event: "session_compact_failed", handler: FeatureHandler<SessionEvents.SessionCompactFailedEvent>): () => void;
	on(event: "session_shutdown", handler: FeatureHandler<SessionEvents.SessionShutdownEvent>): () => void;
	on(event: "mcp_servers_change", handler: FeatureHandler<SessionEvents.McpServersChangeEvent>): () => void;
	on(
		event: "session_before_tree",
		handler: FeatureHandler<SessionEvents.SessionBeforeTreeEvent, SessionBeforeTreeResult>,
	): () => void;
	on(event: "session_tree", handler: FeatureHandler<SessionEvents.SessionTreeEvent>): () => void;
	on(event: "context", handler: FeatureHandler<AgentEvents.ContextEvent, ContextEventResult>): () => void;
	on(
		event: "cache_warming_decision",
		handler: FeatureHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>,
	): () => void;
	on(
		event: "before_agent_start",
		handler: FeatureHandler<AgentEvents.BeforeAgentStartEvent, BeforeAgentStartEventResult>,
	): () => void;
	on(event: "agent_start", handler: FeatureHandler<AgentEvents.AgentStartEvent>): () => void;
	on(event: "agent_end", handler: FeatureHandler<AgentEvents.AgentEndEvent>): () => void;
	on(
		event: "agent_before_settle",
		handler: FeatureHandler<AgentEvents.AgentBeforeSettleEvent, AgentEvents.BoundaryResult>,
	): () => void;
	on(event: "agent_interrupted", handler: FeatureHandler<AgentEvents.AgentInterruptedEvent>): () => void;
	on(event: "agent_settled", handler: FeatureHandler<AgentEvents.AgentSettledEvent>): () => void;
	on(event: "agent_settle_end", handler: FeatureHandler<AgentEvents.AgentSettleEndEvent>): () => void;
	on(event: "ui_prompt_start", handler: FeatureHandler<AgentEvents.UIPromptStartEvent>): () => void;
	on(event: "ui_prompt_end", handler: FeatureHandler<AgentEvents.UIPromptEndEvent>): () => void;
	on(event: "ui_notice", handler: FeatureHandler<AgentEvents.UINoticeEvent>): () => void;
	on(event: "model_stall", handler: FeatureHandler<AgentEvents.ModelStallEvent>): () => void;
	on(event: "turn_start", handler: FeatureHandler<AgentEvents.TurnStartEvent>): () => void;
	on(event: "turn_prompt", handler: FeatureHandler<AgentEvents.TurnPromptEvent>): () => void;
	on(event: "turn_end", handler: FeatureHandler<AgentEvents.TurnEndEvent, AgentEvents.BoundaryResult>): () => void;
	on(event: "message_start", handler: FeatureHandler<AgentEvents.MessageStartEvent>): () => void;
	on(event: "message_update", handler: FeatureHandler<AgentEvents.MessageUpdateEvent>): () => void;
	on(event: "message_end", handler: FeatureHandler<AgentEvents.MessageEndEvent, MessageEndEventResult>): () => void;
	on(event: "tool_execution_start", handler: FeatureHandler<AgentEvents.ToolExecutionStartEvent>): () => void;
	on(event: "tool_execution_update", handler: FeatureHandler<AgentEvents.ToolExecutionUpdateEvent>): () => void;
	on(event: "tool_execution_end", handler: FeatureHandler<AgentEvents.ToolExecutionEndEvent>): () => void;
	on(event: "model_select", handler: FeatureHandler<ModelSelectEvent>): () => void;
	on(event: "thinking_level_select", handler: FeatureHandler<ThinkingLevelSelectEvent>): () => void;
	on(event: "tool_call", handler: FeatureHandler<ToolCallEvent, ToolCallEventResult>): () => void;
	/** Synchronous, with `toolExecution.earlyStart` on: may this model call start before its message ended (every handler true)? */
	on(
		event: "tool_call_early_start",
		handler: (event: Omit<ToolCallEvent, "type">, ctx: FeatureContext) => boolean,
	): () => void;
	/** An early-started call was discarded (its message did not complete); its `tool_call` checks saw a call that never ran. */
	on(event: "tool_call_discarded", handler: (event: { toolCallId: string }) => void): () => void;
	on(event: "tool_result", handler: FeatureHandler<ToolResultEvent, ToolResultEventResult>): () => void;
	on(event: "user_bash", handler: FeatureHandler<UserBashEvent, UserBashEventResult>): () => void;
	on(event: "input", handler: FeatureHandler<InputEvent, InputEventResult>): () => void;
	on(event: "user_input", handler: FeatureHandler<UserInputEvent, UserInputEventResult>): () => void;
}

/** Registers a feature's tools and reads or changes which tools the model sees. */
export interface ToolRegistrar {
	/** Register a tool the model can call. A later registration under the same name replaces it. */
	register<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;
	/** Register several tools at once: all are validated before any is stored, and tools refresh once. */
	registerAll<TDetails = unknown>(tools: readonly ToolDefinition<TSchema, TDetails>[]): void;
	/** The names of the tools the model sees now. */
	getActive(): string[];
	/** Tools that are declared to the provider but hidden from the model's listing. */
	getHiddenDeclarations(): string[];
	/** Every registered tool with its name, description, parameters and source. */
	getAll(): ToolInfo[];
	/** Set the tools the model sees, by name. */
	setActive(toolNames: string[]): void;
	/** Whether the session's tool selection names tools with `prefix`; without a selection, `activeByDefault`. */
	selects(prefix: string, activeByDefault: boolean): boolean;
}

/** Registers slash commands. */
interface CommandRegistrar {
	register(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
}

/** Registers how custom messages, entries and tool calls are drawn. */
interface RendererRegistrar {
	/** Draw custom messages of `customType`. */
	message<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
	/** Draw custom session entries of `customType`. */
	entry<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
	/** Choose renderers for tool calls; resolvers chain in feature load order. */
	tool(resolver: ToolRendererResolver): void;
}

/** Registers model providers; registrations during composition apply when the session binds. */
interface ProviderRegistrar {
	register(provider: Provider): void;
	register(name: string, config: ProviderConfig): void;
}

/** Registers MCP servers, validated when registered and applied when the feature's registration succeeds. */
interface McpServerRegistrar {
	register(name: string, config: McpServerConfig, options?: { inherited?: boolean }): void;
	list(): RegisteredMcpServer[];
}

/** The session a feature writes to: messages, entries, name and labels. */
interface SessionPort {
	/**
	 * Delivers a custom message. The promise rejects when the session cannot take it (a failed session write, a run that
	 * cannot start), so every call needs an owner. With `triggerTurn: false`, `nextTurn` or during a run it settles once
	 * the message is queued or written: await it. A `triggerTurn` send while idle settles when the turn it starts ends,
	 * so a caller that cannot wait that long `.catch`es it into a log instead.
	 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; together?: boolean },
	): void | Promise<void>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void;
	/** Save a record in the session that no model sees. */
	appendEntry<T = unknown>(customType: string, data?: T): void;
	setName(name: string, source?: SessionEvents.SessionInfoChangedEvent["source"]): void;
	getName(): string | undefined;
	setLabel(entryId: string, label: string | undefined): void;
}

/** Records model usage that runs outside the session's turns. */
interface UsagePort {
	createRecorder(kind: string): (message: AssistantMessage) => void;
	record(kind: string, provider: string, model: string, usage: Usage): void;
}

/** The session's model and thinking level. */
interface ModelPort {
	setModel(model: Model<any>): Promise<boolean>;
	getThinkingLevel(): ThinkingLevel;
}

/** The effective settings, read-only. */
interface SettingsView {
	get(): Settings;
}

/** Commands and skills the session has loaded. */
interface ResourcesPort {
	getCommands(): SlashCommandInfo[];
	getSkillDirectories(): string[];
	getSkillResourceSnapshot(names?: readonly string[]): SkillResourceSnapshot;
}

/**
 * What a feature may do while it is composed: subscribe to the session bus, register into the registries, and use the
 * session's services. A feature module takes only the slices it uses.
 */
export interface FeatureSetup {
	readonly bus: BusSubscriber;
	readonly tools: ToolRegistrar;
	readonly commands: CommandRegistrar;
	readonly renderers: RendererRegistrar;
	readonly providers: ProviderRegistrar;
	readonly mcpServers: McpServerRegistrar;
	readonly session: SessionPort;
	readonly usage: UsagePort;
	readonly models: ModelPort;
	readonly settings: SettingsView;
	readonly resources: ResourcesPort;
	/** Named channels between features, unsubscribed when the session is replaced. */
	readonly channels: EventBus;
}

/** Some members of one setup slice: `SetupPick<"session", "sendMessage">`. Intersect them for several slices. */
export type SetupPick<S extends keyof FeatureSetup, M extends keyof FeatureSetup[S]> = {
	readonly [K in S]: Pick<FeatureSetup[K], M>;
};
