import { withSessionStorage } from "../../storage/runtime-paths.ts";
import type { Provider } from "@octocodeai/octocode-ai";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import { subscribe } from "./bus/session-bus.ts";
import { validateMcpServerConfig } from "../../../../mcp/src/api.ts";
import { type McpServerChange, type McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import type {
	BusSubscriber,
	FeatureRecord,
	FeatureRuntime,
	FeatureSetup,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

/**
 * Create the setup a feature registers through. Registrations write into the feature's record; services delegate to
 * the shared runtime. Provider and MCP server registrations are staged until `commit()`, and `discard()` drops a failed
 * feature's staged changes and channel subscriptions, so a partly registered feature never reaches the session.
 */
export function createFeatureSetup(
	feature: FeatureRecord,
	runtime: FeatureRuntime,
	eventBus: EventBus,
): { setup: FeatureSetup; commit: () => void; discard: () => void } {
	const pendingRuntimeChanges: Array<() => void> = [];
	const pendingMcpChanges: McpServerChange[] = [];
	const loadingUnsubscribers: Array<() => void> = [];
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed") {
			throw new Error(`Feature "${feature.path}" failed to register and its setup is no longer active.`);
		}
		runtime.assertActive();
	};
	/** `fn` behind the active check. */
	const active =
		<A extends unknown[], R>(fn: (...args: A) => R) =>
		(...args: A): R => {
			assertActive();
			return fn(...args);
		};
	const assertToolShape = (tool: ToolDefinition) => {
		if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
			throw new Error(`Tool "${tool.name}" registered by "${feature.path}" must define an object parameter schema.`);
		}
	};
	const storeTool = (tool: ToolDefinition) => {
		assertToolShape(tool);
		feature.tools.set(tool.name, { definition: tool, sourceInfo: feature.sourceInfo });
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
		pendingRuntimeChanges.length = 0;
		pendingMcpChanges.length = 0;
		loadingUnsubscribers.length = 0;
	};

	const bus: BusSubscriber = {
		on: active((event: string, handler: (...args: unknown[]) => unknown) => subscribe(feature, event, handler)),
	} as BusSubscriber;

	const setup: FeatureSetup = {
		bus,
		tools: {
			register: active((tool: ToolDefinition) => {
				storeTool(tool);
				runtime.refreshTools();
			}) as FeatureSetup["tools"]["register"],
			registerAll: active((tools: readonly ToolDefinition[]) => {
				// Validate all before storing any, so one bad definition leaves the registry as it was.
				for (const tool of tools) assertToolShape(tool);
				if (tools.length === 0) return;
				for (const tool of tools) storeTool(tool);
				runtime.refreshTools();
			}) as FeatureSetup["tools"]["registerAll"],
			getActive: active(() => runtime.getActiveTools()),
			getHiddenDeclarations: active(() => runtime.getHiddenDeclarations()),
			getAll: active(() => runtime.getAllTools()),
			setActive: active((toolNames: string[]) =>
				runtime.setActiveTools(toolNames, { boundary: feature.owner !== "native" }),
			),
			selects: active((prefix: string, activeByDefault: boolean) => runtime.selectsTools(prefix, activeByDefault)),
			// Not on the `ToolRegistrar` type; see `NativeFeatureSetup` in src/octocode/shared/host-api.ts.
			setPolicy: active((allows: (name: string) => boolean) => {
				if (feature.owner !== "native") throw new Error("Tool permission policy is owned by native features");
				runtime.setToolPolicy?.(allows);
			}),
		} as FeatureSetup["tools"],
		commands: {
			register: active((name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				if (typeof name !== "string" || name.length === 0) {
					throw new Error(
						`Command registered by "${feature.path}" must have a non-empty string name. Use commands.register("name", { description, handler }).`,
					);
				}
				if (typeof options?.handler !== "function") {
					throw new Error(`Command "/${name}" registered by "${feature.path}" must define handler().`);
				}
				if ("aliases" in options) {
					throw new Error(
						`Command "/${name}" registered by "${feature.path}" passes aliases, which are no longer supported. Register each command under one name.`,
					);
				}
				feature.commands.set(name, {
					name,
					sourceInfo: feature.sourceInfo,
					...options,
					handler: (args, ctx) => withSessionStorage(ctx.sessionManager, () => options.handler(args, ctx)),
				});
			}),
		},
		renderers: {
			message: active((customType, renderer) => {
				feature.messageRenderers.set(customType, renderer as never);
			}),
			entry: active((customType, renderer) => {
				feature.entryRenderers ??= new Map();
				feature.entryRenderers.set(customType, renderer as never);
			}),
			tool: active((resolver) => {
				feature.toolRenderers ??= [];
				feature.toolRenderers.push(resolver);
			}),
		},
		providers: {
			register: active((providerOrName: Provider | string, config?: ProviderConfig) => {
				if (typeof providerOrName === "string") {
					if (!config) throw new Error("Provider config is required when registering by name");
					applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, feature.path));
					return;
				}
				applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, feature.path));
			}),
		},
		mcpServers: {
			register: active((name: string, config: McpServerConfig, options?: { inherited?: boolean }) => {
				const validated = validateMcpServerConfig(name, config);
				if (typeof validated === "string") {
					throw new Error(`Invalid MCP server registered by "${feature.path}": ${validated}`);
				}
				const server = {
					name,
					config: structuredClone(validated),
					source: feature.path,
					...(options?.inherited ? { inherited: true as const } : {}),
				};
				applyMcpChange({ type: "register", server });
			}),
			list: active(() => runtime.mcpServers.list()),
		},
		session: {
			sendMessage: active((message, options) => runtime.sendMessage(message, options)),
			sendUserMessage: active((content, options) => runtime.sendUserMessage(content, options)),
			appendEntry: active((customType: string, data?: unknown) => runtime.appendEntry(customType, data)),
			setName: active((name, source) => runtime.setSessionName(name, source)),
			getName: active(() => runtime.getSessionName()),
			setLabel: active((entryId: string, label: string | undefined) => runtime.setLabel(entryId, label)),
		},
		usage: {
			createRecorder: active((kind: string) => runtime.createUsageRecorder(kind)),
			record: active((kind, provider, model, usage) => runtime.recordUsage(kind, provider, model, usage)),
		},
		models: {
			setModel: active((model) => runtime.setModel(model)),
			getThinkingLevel: active(() => runtime.getThinkingLevel()),
		},
		settings: { get: active(() => runtime.getSettings()) },
		resources: {
			getCommands: active(() => runtime.getCommands()),
			getSkillDirectories: active(() => runtime.getSkillDirectories()),
			getSkillResourceSnapshot: active((names?: readonly string[]) => runtime.getSkillResourceSnapshot(names)),
		},
		channels: {
			emit: active((channel: string, data: unknown) => eventBus.emit(channel, data)),
			on: active((channel: string, handler: (data: unknown) => void) => {
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				return unsubscribe;
			}),
		},
	};

	return {
		setup,
		commit: () => {
			if (state !== "loading") return;
			runtime.assertActive();
			runtime.mcpServers.apply(pendingMcpChanges);
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
