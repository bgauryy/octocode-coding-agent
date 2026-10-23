/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, ProviderHeaders } from "@octocodeai/octocode-ai";
import type { KeyId } from "@octocodeai/octocode-tui";
import type { CacheWarmingAction } from "../cache-warmer.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import { bindRunnerCommandContext, bindRunnerCore, createRunnerBindings } from "./runner/bind.ts";
import {
	createExtensionCommandContext,
	createExtensionContext,
	createExtensionToolContext,
	noOpUIContext,
} from "./runner/context.ts";
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
	dispatchBeforeProviderHeaders,
	dispatchBeforeProviderRequest,
	dispatchContext,
	dispatchInput,
	dispatchResourcesDiscover,
	dispatchUserInput,
} from "./runner/emit-transforms.ts";
import { reportMcpServersOnce } from "./runner/event-handlers.ts";
import {
	collectFlags,
	collectRegisteredTools,
	findEntryRenderer,
	findMessageRenderer,
	hasEventHandlers,
	resolveRegisteredCommands,
	resolveShortcuts,
} from "./runner/registrations.ts";
import type * as Runner from "./runner/types.ts";
import { UIPromptTracker } from "./runner/ui-prompt.ts";
import type * as Types from "./types.ts";

export { emitProjectTrustEvent } from "./runner/event-handlers.ts";
export type {
	BeforeAgentStartTrigger,
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner/types.ts";

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: Types.SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

export class ExtensionRunner {
	private readonly extensions: Types.Extension[];
	private readonly runtime: Types.ExtensionRuntime;
	private uiContext: Types.ExtensionUIContext;
	private mode: Types.ExtensionMode = "print";
	private readonly cwd: string;
	private readonly sessionManager: SessionManager;
	private readonly modelRegistry: ModelRegistry;
	private errorListeners: Set<Runner.ExtensionErrorListener> = new Set();
	/** Callbacks bound by bindCore() and bindCommandContext(). */
	private readonly bindings: Runner.RunnerBindings;
	/** The runner as the delegated parts in `runner/` see it. */
	private readonly host: Runner.RunnerHost;
	/** Registered MCP servers already reported as unhandled. */
	private readonly reportedMcpServers = new Set<string>();
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private readonly uiPrompts = new UIPromptTracker((event) => this.emit(event));

	constructor(
		extensions: Types.Extension[],
		runtime: Types.ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.bindings = createRunnerBindings(cwd);
		// oxlint-disable-next-line typescript/no-this-alias -- the host's getters have their own `this` and resolve runner state at access time
		const runner = this;
		this.host = {
			extensions,
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
		actions: Types.ExtensionActions,
		contextActions: Types.ExtensionContextActions,
		providerActions?: Runner.RunnerProviderActions,
	): void {
		bindRunnerCore(this.host, actions, contextActions, providerActions);
	}

	bindCommandContext(actions?: Types.ExtensionCommandContextActions): void {
		bindRunnerCommandContext(this.bindings, actions);
	}

	setUIContext(uiContext?: Types.ExtensionUIContext, mode: Types.ExtensionMode = "print"): void {
		this.uiContext = uiContext ? this.uiPrompts.wrap(uiContext) : noOpUIContext;
		this.mode = mode;
	}

	getUIContext(): Types.ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** User registrations override native tools; the first user registration per name wins. */
	getAllRegisteredTools(): Types.RegisteredTool[] {
		return collectRegisteredTools(this.extensions);
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): Types.RegisteredTool["definition"] | undefined {
		return this.getAllRegisteredTools().find((tool) => tool.definition.name === toolName)?.definition;
	}

	getFlags(): Map<string, Types.ExtensionFlag> {
		return collectFlags(this.extensions);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, Types.ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		return resolveShortcuts(this.extensions, resolvedKeybindings, (message, extensionPath) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		});
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
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

	onError(listener: Runner.ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: Types.ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	/**
	 * Report registered MCP servers when no extension handles `mcp_servers_change`, which means
	 * nothing connects them (for example when another MCP extension replaced the built-in one).
	 */
	reportUnhandledMcpServers(): void {
		if (this.hasHandlers("mcp_servers_change")) return;
		reportMcpServersOnce(this.runtime, this.reportedMcpServers, (error) => this.emitError(error));
	}

	hasHandlers(eventType: string): boolean {
		return hasEventHandlers(this.extensions, eventType);
	}

	getMessageRenderer(customType: string): Types.MessageRenderer | undefined {
		return findMessageRenderer(this.extensions, customType);
	}

	getMarkdownTransformers(): Types.MarkdownTransformer[] {
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	/** Renderers of calls to `toolName`: extension resolvers in load order, then `base`. */
	resolveToolRenderers(toolName: string, base: () => Types.ToolRenderers | undefined): Types.ToolRenderers | undefined {
		const resolvers = this.extensions.flatMap((ext) => ext.toolRenderers ?? []);
		const resolve = (index: number): Types.ToolRenderers | undefined =>
			index < resolvers.length ? resolvers[index](toolName, () => resolve(index + 1)) : base();
		return resolve(0);
	}

	getEntryRenderer(customType: string): Types.EntryRenderer | undefined {
		return findEntryRenderer(this.extensions, customType);
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): Types.ResolvedCommand[] {
		this.commandDiagnostics = [];
		return resolveRegisteredCommands(this.extensions);
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): Types.ResolvedCommand | undefined {
		const commands = resolveRegisteredCommands(this.extensions);
		return (
			commands.find((command) => command.invocationName === name) ??
			commands.find((command) => command.aliases?.includes(name))
		);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.bindings.shutdownHandler();
	}

	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an Types.ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): Types.ExtensionContext {
		return createExtensionContext(this.host);
	}

	/**
	 * Create the context for executing the tool call `toolCallId`: the extension context plus
	 * `tools` and `executeTool()`. `signal` is the default signal of nested calls.
	 */
	createToolContext(toolCallId: string, signal: AbortSignal | undefined): Types.ExtensionToolContext {
		return createExtensionToolContext(this.host, toolCallId, signal);
	}

	createCommandContext(): Types.ExtensionCommandContext {
		return createExtensionCommandContext(this.host);
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

	/**
	 * Run the request-time transforms in two phases. `context` handlers see the conversation
	 * only and Pi restores the prompt and tool state after each; `context_with_system`
	 * handlers then see the full transcript and their output is used as returned.
	 */
	emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		return dispatchContext(this.host, messages);
	}

	emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		return dispatchBeforeProviderRequest(this.host, payload);
	}

	emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		return dispatchBeforeProviderHeaders(this.host, headers);
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
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
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
