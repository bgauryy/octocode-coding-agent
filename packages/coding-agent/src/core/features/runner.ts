/**
 * Feature runner - executes features and manages their lifecycle.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent } from "@octocodeai/octocode-ai";
import type { CacheWarmingAction } from "../cache-warmer.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import { bindRunnerCommandContext, bindRunnerCore, createRunnerBindings } from "./runner/bind.ts";
import { createCommandContext, createFeatureContext, createToolContext, noOpUIContext } from "./runner/context.ts";
import {
	dispatchBoundary,
	dispatchCacheWarmingDecision,
	dispatchEvent,
	dispatchMessageEnd,
	dispatchToolCall,
	dispatchToolResult,
	dispatchUserBash,
} from "./runner/emit-events.ts";
import {
	dispatchBeforeAgentStart,
	dispatchContext,
	dispatchInput,
	dispatchResourcesDiscover,
	dispatchUserInput,
} from "./runner/emit-transforms.ts";
import type { BusEventType } from "./bus/events.ts";
import { SessionBus } from "./bus/session-bus.ts";
import { reportMcpServersOnce } from "./runner/event-handlers.ts";
import {
	collectRegisteredTools,
	findEntryRenderer,
	findMessageRenderer,
	commandResolutionDiagnostics,
	resolveRegisteredCommands,
} from "./runner/registrations.ts";
import type * as Runner from "./runner/types.ts";
import { type DialogAnswer, type DialogAnswerResult, UIPromptTracker } from "./runner/ui-prompt.ts";
import type * as Types from "./types.ts";

export type { BeforeAgentStartTrigger, FeatureErrorListener, ShutdownHandler } from "./runner/types.ts";

/**
 * Helper function to emit session_shutdown event to features.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	featureHost: FeatureHost,
	event: Types.SessionShutdownEvent,
): Promise<boolean> {
	if (featureHost.hasHandlers("session_shutdown")) {
		await featureHost.emit(event);
		return true;
	}
	return false;
}

export class FeatureHost {
	private readonly features: Types.FeatureRecord[];
	/** The subscriptions of every feature, which every dispatch reads. */
	readonly bus: SessionBus;
	private readonly runtime: Types.FeatureRuntime;
	private uiContext: Types.SessionUI;
	private mode: Types.UiMode = "print";
	private readonly cwd: string;
	private readonly sessionManager: SessionManager;
	private readonly modelRegistry: ModelRegistry;
	private errorListeners: Set<Runner.FeatureErrorListener> = new Set();
	/** Callbacks bound by bindCore() and bindCommandContext(). */
	private readonly bindings: Runner.RunnerBindings;
	/** The runner as the delegated parts in `runner/` see it. */
	private readonly host: Runner.RunnerHost;
	/** Registered MCP servers already reported as unhandled. */
	private readonly reportedMcpServers = new Set<string>();
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private readonly uiPrompts = new UIPromptTracker((event) => this.emit(event));

	constructor(
		features: Types.FeatureRecord[],
		runtime: Types.FeatureRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.features = features;
		this.bus = new SessionBus(features);
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.bindings = createRunnerBindings(cwd);
		// oxlint-disable-next-line typescript/no-this-alias -- the host's getters have their own `this` and resolve runner state at access time
		const runner = this;
		this.host = {
			features,
			bus: this.bus,
			runtime,
			cwd,
			sessionManager,
			modelRegistry,
			get uiContext() {
				return runner.uiContext;
			},
			get mode() {
				return runner.mode;
			},
			bindings: this.bindings,
			hasUI: () => this.hasUI(),
			assertActive: () => this.assertActive(),
			createContext: () => this.createContext(),
			emit: (event) => this.emit(event),
			emitError: (error) => this.emitError(error),
			reportUnhandledMcpServers: () => this.reportUnhandledMcpServers(),
		};
	}

	bindCore(
		actions: Types.SessionActions,
		contextActions: Types.ContextActions,
		providerActions?: Runner.RunnerProviderActions,
	): void {
		bindRunnerCore(this.host, actions, contextActions, providerActions);
	}

	bindCommandContext(actions?: Types.CommandActions): void {
		bindRunnerCommandContext(this.bindings, actions);
	}

	setUIContext(uiContext?: Types.SessionUI, mode: Types.UiMode = "print"): void {
		this.uiContext = uiContext ? this.uiPrompts.wrap(uiContext) : noOpUIContext;
		this.mode = mode;
	}

	getUIContext(): Types.SessionUI {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getFeaturePaths(): string[] {
		return this.features.map((e) => e.path);
	}

	/** User registrations override native tools; the first user registration per name wins. */
	getAllRegisteredTools(): Types.RegisteredTool[] {
		return collectRegisteredTools(this.features);
	}

	getToolDefinition(toolName: string): Types.RegisteredTool["definition"] | undefined {
		return this.getAllRegisteredTools().find((tool) => tool.definition.name === toolName)?.definition;
	}

	invalidate(
		message = "This feature ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: Runner.FeatureErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	hasErrorListeners(): boolean {
		return this.errorListeners.size > 0;
	}

	emitError(error: Types.FeatureError): void {
		for (const listener of this.errorListeners) {
			try {
				listener(error);
			} catch {
				// emitError runs inside the catch of every dispatch: a failing reporter must not turn a contained handler
				// failure into a rejected dispatch or skip the other reporters.
			}
		}
	}

	/**
	 * Report registered MCP servers when no feature handles `mcp_servers_change`, which means
	 * nothing connects them (for example when another MCP feature replaced the built-in one).
	 */
	reportUnhandledMcpServers(): void {
		if (this.hasHandlers("mcp_servers_change")) return;
		reportMcpServersOnce(this.runtime, this.reportedMcpServers, (error) => this.emitError(error));
	}

	/** Answer the open dialog `id` for a client other than this mode's UI (`UIPromptTracker.answer`). */
	answerDialog(id: string, answer: DialogAnswer): DialogAnswerResult {
		return this.uiPrompts.answer(id, answer);
	}

	/** A client started answering the open dialog `id`: stop its countdown (`UIPromptTracker.hold`). */
	holdDialog(id: string): DialogAnswerResult {
		return this.uiPrompts.hold(id);
	}

	hasHandlers(eventType: string): boolean {
		return this.bus.has(eventType as BusEventType);
	}

	/** `tool_call_early_start`: true only when some handler answers and every handler returns true; a throw is false. */
	mayStartToolCallEarly(event: Omit<Types.ToolCallEvent, "type">): boolean {
		const handlers = this.bus.handlers("tool_call_early_start");
		try {
			const ctx = this.createContext();
			return (
				handlers.length > 0 &&
				handlers.every((handler) => (handler as (e: typeof event, c: typeof ctx) => unknown)(event, ctx) === true)
			);
		} catch {
			return false;
		}
	}

	/** `tool_call_discarded`, synchronously; a failing handler does not stop the others. */
	toolCallDiscarded(toolCallId: string): void {
		for (const handler of this.bus.handlers("tool_call_discarded")) {
			try {
				void (handler as (e: { toolCallId: string }) => unknown)({ toolCallId });
			} catch {
				// A cleanup handler's failure leaves only its own leftovers.
			}
		}
	}

	getMessageRenderer(customType: string): Types.MessageRenderer | undefined {
		return findMessageRenderer(this.features, customType);
	}

	/** Renderers of calls to `toolName`: feature resolvers in load order, then `base`. */
	resolveToolRenderers(toolName: string, base: () => Types.ToolRenderers | undefined): Types.ToolRenderers | undefined {
		const resolvers = this.features.flatMap((ext) => ext.toolRenderers ?? []);
		const resolve = (index: number): Types.ToolRenderers | undefined =>
			index < resolvers.length ? resolvers[index](toolName, () => resolve(index + 1)) : base();
		return resolve(0);
	}

	getEntryRenderer(customType: string): Types.EntryRenderer | undefined {
		return findEntryRenderer(this.features, customType);
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): Types.ResolvedCommand[] {
		const commands = resolveRegisteredCommands(this.features);
		this.commandDiagnostics = commandResolutionDiagnostics(commands);
		return commands;
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): Types.ResolvedCommand | undefined {
		return resolveRegisteredCommands(this.features).find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by feature tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindFeatures().
	 */
	shutdown(): void {
		this.bindings.shutdownHandler();
	}

	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an Types.FeatureContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): Types.FeatureContext {
		return createFeatureContext(this.host);
	}

	/**
	 * Create the context for executing the tool call `toolCallId`: the feature context plus
	 * `tools` and `executeTool()`. `signal` is the default signal of nested calls.
	 */
	createToolContext(toolCallId: string, signal: AbortSignal | undefined): Types.ToolContext {
		return createToolContext(this.host, toolCallId, signal);
	}

	createCommandContext(): Types.CommandContext {
		return createCommandContext(this.host);
	}

	emitBoundary(
		baseEvent: Runner.BoundaryBaseEvent,
		buildContext: (
			entries: Types.SessionBoundaryDraft[],
		) => Types.BoundaryContextPreview | Promise<Types.BoundaryContextPreview>,
	): Promise<Runner.BoundaryDispatchResult> {
		return dispatchBoundary(this.host, baseEvent, buildContext);
	}

	emit<TEvent extends Runner.RunnerEmitEvent>(event: TEvent): Promise<Runner.RunnerEmitResult<TEvent>> {
		return dispatchEvent(this.host, event);
	}

	/** Returns the event's own action unless a handler overrides it; the last override wins. */
	emitCacheWarmingDecision(event: Types.CacheWarmingDecisionEvent): Promise<CacheWarmingAction> {
		return dispatchCacheWarmingDecision(this.host, event);
	}

	emitMessageEnd(event: Types.MessageEndEvent): Promise<AgentMessage | undefined> {
		return dispatchMessageEnd(this.host, event);
	}

	emitToolResult(event: Types.ToolResultEvent): Promise<Types.ToolResultEventResult | undefined> {
		return dispatchToolResult(this.host, event);
	}

	emitToolCall(event: Types.ToolCallEvent, signal?: AbortSignal): Promise<Types.ToolCallEventResult | undefined> {
		return dispatchToolCall(this.host, event, signal);
	}

	emitUserBash(event: Types.UserBashEvent): Promise<Types.UserBashEventResult | undefined> {
		return dispatchUserBash(this.host, event);
	}

	/** Run the `context` handlers: they see the conversation only, and Octocode restores the prompt and tool state after each. */
	emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		return dispatchContext(this.host, messages);
	}

	emitBeforeAgentStart(
		trigger: Runner.BeforeAgentStartTrigger,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<Runner.BeforeAgentStartCombinedResult> {
		return dispatchBeforeAgentStart(this.host, trigger, systemPromptOptions);
	}

	emitResourcesDiscover(
		cwd: string,
		reason: Types.ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; source: string }>;
		promptPaths: Array<{ path: string; source: string }>;
		themePaths: Array<{ path: string; source: string }>;
	}> {
		return dispatchResourcesDiscover(this.host, cwd, reason);
	}

	emitUserInput(event: Types.UserInputEvent): Promise<Types.UserInputEventResult> {
		return dispatchUserInput(this.host, event);
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: Types.InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<Types.InputEventResult> {
		return dispatchInput(this.host, text, images, source, streamingBehavior);
	}
}
