import type { Provider } from "@octocodeai/octocode-ai";
import type { KeyId } from "@octocodeai/octocode-tui";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import type { ExecOptions } from "../../exec.ts";
import { execCommand } from "../../exec.ts";
import { type McpServerChange, type McpServerConfig, validateMcpServerConfig } from "../../../../../mcp/src/servers.ts";
import { NATIVE_FEATURE_PATH } from "../../native-tools.ts";
import type { ModelRouteRequest, VirtualModelDefinition } from "../../virtual-models.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionRuntime,
	ExtensionVirtualModel,
	MarkdownTransformer,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
	ToolRendererResolver,
} from "../types.ts";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
export function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	const pendingFlagValues = new Map<string, boolean | string>();
	const pendingRuntimeChanges: Array<() => void> = [];
	const pendingMcpChanges: McpServerChange[] = [];
	const loadingUnsubscribers: Array<() => void> = [];
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed") {
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		}
		runtime.assertActive();
	};
	const assertToolShape = (tool: ToolDefinition) => {
		if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
			throw new Error(
				`Tool "${tool.name}" registered by extension "${extension.path}" must define an object parameter schema.`,
			);
		}
	};
	const storeTool = (tool: ToolDefinition) => {
		assertToolShape(tool);
		extension.tools.set(tool.name, { definition: tool, sourceInfo: extension.sourceInfo });
	};
	const applyRuntimeChange = (change: () => void) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else change();
	};
	const applyMcpChange = (change: McpServerChange) => {
		if (state === "loading") {
			runtime.mcpServers.validate([...pendingMcpChanges, change]);
			pendingMcpChanges.push(change);
		} else runtime.mcpServers.apply([change]);
	};
	const clearPending = () => {
		pendingFlagValues.clear();
		pendingRuntimeChanges.length = 0;
		pendingMcpChanges.length = 0;
		loadingUnsubscribers.length = 0;
	};

	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): () => void {
			assertActive();
			const registeredHandler: HandlerFn = (...args) => handler(...args);
			const list = extension.handlers.get(event) ?? [];
			list.push(registeredHandler);
			extension.handlers.set(event, list);

			return () => {
				const handlers = extension.handlers.get(event);
				if (!handlers) return;
				const handlerIndex = handlers.indexOf(registeredHandler);
				if (handlerIndex === -1) return;
				handlers.splice(handlerIndex, 1);
				if (handlers.length === 0) extension.handlers.delete(event);
			};
		},

		registerTool(tool: ToolDefinition): void {
			assertActive();
			storeTool(tool);
			runtime.refreshTools();
		},

		registerTools(tools: readonly ToolDefinition[]): void {
			assertActive();
			// Validate all before storing any, so one bad definition leaves the registry as it was.
			for (const tool of tools) assertToolShape(tool);
			if (tools.length === 0) return;
			for (const tool of tools) storeTool(tool);
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			if (typeof name !== "string" || name.length === 0) {
				throw new Error(
					`Command registered by extension "${extension.path}" must have a non-empty string name. Use api.registerCommand("name", { description, handler }).`,
				);
			}
			if (typeof options?.handler !== "function") {
				throw new Error(`Command "/${name}" registered by extension "${extension.path}" must define handler().`);
			}
			if ("aliases" in options) {
				throw new Error(
					`Command "/${name}" registered by extension "${extension.path}" passes aliases, which are no longer supported. Register each command under one name.`,
				);
			}
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			assertActive();
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`);
			}
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (state === "loading") {
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			assertActive();
			extension.markdownTransformer = transformer;
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			assertActive();
			extension.entryRenderers ??= new Map();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		registerToolRenderer(resolver: ToolRendererResolver): void {
			assertActive();
			extension.toolRenderers ??= [];
			extension.toolRenderers.push(resolver);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void | Promise<void> {
			assertActive();
			return runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			assertActive();
			runtime.sendUserMessage(content, options);
		},

		createUsageRecorder(kind) {
			assertActive();
			return runtime.createUsageRecorder(kind);
		},

		appendEntry(customType: string, data?: unknown): void {
			assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			assertActive();
			return runtime.getAllTools();
		},

		getSettings() {
			assertActive();
			return runtime.getSettings();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			runtime.setActiveTools(toolNames);
		},

		selectsTools(prefix: string, activeByDefault: boolean): boolean {
			assertActive();
			return runtime.selectsTools(prefix, activeByDefault);
		},

		// Not on the public ExtensionAPI type; see `NativeExtensionAPI` in src/octocode/shared/host-api.ts.
		setToolPolicy(allows: (name: string) => boolean) {
			assertActive();
			if (extension.sourceInfo.path !== NATIVE_FEATURE_PATH)
				throw new Error("Tool permission policy is owned by native features");
			runtime.setToolPolicy?.(allows);
		},

		getCommands() {
			assertActive();
			return runtime.getCommands();
		},

		getSkillResourceSnapshot(names) {
			assertActive();
			return runtime.getSkillResourceSnapshot(names);
		},

		getSkillDirectories() {
			assertActive();
			return runtime.getSkillDirectories();
		},

		setModel(model) {
			assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			assertActive();
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));
				return;
			}
			applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, extension.path));
		},

		unregisterProvider(name: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
		},

		registerMcpServer(name: string, config: McpServerConfig) {
			assertActive();
			const validated = validateMcpServerConfig(name, config);
			if (typeof validated === "string") {
				throw new Error(`Invalid MCP server registered by extension "${extension.path}": ${validated}`);
			}
			const server = { name, config: structuredClone(validated), extensionPath: extension.path };
			applyMcpChange({ type: "register", server });
		},

		unregisterMcpServer(name: string) {
			assertActive();
			applyMcpChange({ type: "unregister", name, extensionPath: extension.path });
		},

		getMcpServers() {
			assertActive();
			return runtime.mcpServers.list();
		},

		registerVirtualModel<TState>(model: ExtensionVirtualModel<TState>) {
			assertActive();
			// Routing runs after the runner binds, so the context is created per request. The state
			// comes from the session branch that this router wrote.
			const definition: VirtualModelDefinition = {
				...model,
				route: (request) => model.route(request as ModelRouteRequest<TState>, runtime.createContext()),
			};
			applyRuntimeChange(() => runtime.registerVirtualModel(definition, extension.path));
		},

		unregisterVirtualModel(provider: string, id: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterVirtualModel(provider, id));
		},

		events: {
			emit(channel, data) {
				assertActive();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				assertActive();
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as ExtensionAPI;

	return {
		api,
		commit: () => {
			if (state !== "loading") return;
			runtime.assertActive();
			runtime.mcpServers.apply(pendingMcpChanges);
			for (const [name, value] of pendingFlagValues) {
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			for (const apply of pendingRuntimeChanges) apply();
			state = "active";
			clearPending();
		},
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			clearPending();
		},
	};
}
