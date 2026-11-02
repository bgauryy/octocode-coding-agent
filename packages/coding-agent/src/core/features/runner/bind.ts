/** Binding a runner to its session: runtime actions, context callbacks, command actions and provider registration. */

import { normalizeBuildSystemPromptOptions } from "../../system-prompt.ts";
import { createSessionUsageRecorder } from "../../usage-totals.ts";
import type { VirtualModelDefinition } from "../../virtual-models.ts";
import type { ExtensionActions, ExtensionCommandContextActions, ExtensionContextActions } from "../types.ts";
import type { RunnerBindings, RunnerHost, RunnerProviderActions } from "./types.ts";

/** The callbacks a runner uses before `bindCore()` and `bindCommandContext()` supply the session's. */
export function createRunnerBindings(cwd: string): RunnerBindings {
	return {
		getModel: () => undefined,
		getScopedModels: () => [],
		getExplicitToolNames: () => [],
		isIdleFn: () => true,
		isProjectTrustedFn: () => true,
		getTurnIdFn: () => undefined,
		getSignalFn: () => undefined,
		waitForIdleFn: async () => {},
		abortFn: () => {},
		hasPendingMessagesFn: () => false,
		isMessageQueuedFn: () => false,
		getContextUsageFn: () => undefined,
		compactFn: () => {},
		getSystemPromptFn: () => "",
		getSystemPromptOptionsFn: () => normalizeBuildSystemPromptOptions({ cwd }),
		executeToolFn: undefined,
		getCallableToolsFn: () => [],
		newSessionHandler: async () => ({ cancelled: false }),
		forkHandler: async () => ({ cancelled: false }),
		navigateTreeHandler: async () => ({ cancelled: false }),
		switchSessionHandler: async () => ({ cancelled: false }),
		reloadHandler: async () => {},
		shutdownHandler: () => {},
	};
}

export function bindRunnerCore(
	host: RunnerHost,
	actions: ExtensionActions,
	contextActions: ExtensionContextActions,
	providerActions?: RunnerProviderActions,
): void {
	// Copy actions into the shared runtime (all extension APIs reference this)
	host.runtime.sendMessage = actions.sendMessage;
	host.runtime.sendUserMessage = actions.sendUserMessage;
	host.runtime.appendEntry = actions.appendEntry;
	host.runtime.createUsageRecorder = (kind) =>
		createSessionUsageRecorder(host.sessionManager, kind, contextActions.onUsageRecorded);
	host.runtime.setSessionName = actions.setSessionName;
	host.runtime.getSessionName = actions.getSessionName;
	host.runtime.setLabel = actions.setLabel;
	host.runtime.getActiveTools = actions.getActiveTools;
	host.runtime.getAllTools = actions.getAllTools;
	host.runtime.getSettings = actions.getSettings;
	host.runtime.setActiveTools = actions.setActiveTools;
	host.runtime.selectsTools = actions.selectsTools;
	host.runtime.setToolPolicy = actions.setToolPolicy;
	host.runtime.refreshTools = actions.refreshTools;
	host.runtime.getCommands = actions.getCommands;
	host.runtime.getSkillDirectories = actions.getSkillDirectories;
	host.runtime.getSkillResourceSnapshot = actions.getSkillResourceSnapshot;
	host.runtime.setModel = actions.setModel;
	host.runtime.getThinkingLevel = actions.getThinkingLevel;
	host.runtime.setThinkingLevel = actions.setThinkingLevel;
	host.runtime.createContext = () => host.createContext();

	// Context actions (required)
	host.bindings.getModel = contextActions.getModel;
	host.bindings.getScopedModels = contextActions.getScopedModels;
	host.bindings.getExplicitToolNames = contextActions.getExplicitToolNames ?? (() => []);
	host.bindings.isIdleFn = contextActions.isIdle;
	host.bindings.isProjectTrustedFn = contextActions.isProjectTrusted;
	host.bindings.getSignalFn = contextActions.getSignal;
	host.bindings.getTurnIdFn = contextActions.getTurnId ?? (() => undefined);
	host.bindings.abortFn = contextActions.abort;
	host.bindings.hasPendingMessagesFn = contextActions.hasPendingMessages;
	host.bindings.isMessageQueuedFn = contextActions.isMessageQueued;
	host.bindings.shutdownHandler = contextActions.shutdown;
	host.bindings.getContextUsageFn = contextActions.getContextUsage;
	host.bindings.compactFn = contextActions.compact;
	host.bindings.getSystemPromptFn = contextActions.getSystemPrompt;
	host.bindings.getSystemPromptOptionsFn =
		contextActions.getSystemPromptOptions ?? (() => normalizeBuildSystemPromptOptions({ cwd: host.cwd }));
	host.bindings.executeToolFn = contextActions.executeTool;
	host.bindings.getCallableToolsFn = contextActions.getCallableTools ?? (() => []);

	// Servers registered from now on reach the extension that connects them right away. Servers
	// registered during loading are read on session_start.
	host.runtime.mcpServers.setChangeListener(() => {
		void host.emit({ type: "mcp_servers_change", servers: host.runtime.mcpServers.list() });
		host.reportUnhandledMcpServers();
	});

	// Flush provider registrations queued during extension loading
	for (const { name, config, extensionPath } of host.runtime.pendingProviderRegistrations) {
		try {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
			} else {
				host.modelRegistry.registerProvider(name, config);
			}
		} catch (err) {
			host.emitError({
				extensionPath,
				event: "register_provider",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		}
	}
	host.runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of host.runtime.pendingNativeProviderRegistrations) {
		try {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider);
			} else {
				host.modelRegistry.registerProvider(provider);
			}
		} catch (err) {
			host.emitError({
				extensionPath,
				event: "register_provider",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		}
	}
	host.runtime.pendingNativeProviderRegistrations = [];
	const registerVirtualModel = (definition: VirtualModelDefinition) => {
		if (providerActions?.registerVirtualModel) providerActions.registerVirtualModel(definition);
		else host.modelRegistry.registerVirtualModel(definition);
	};
	for (const { definition, extensionPath } of host.runtime.pendingVirtualModelRegistrations) {
		try {
			registerVirtualModel(definition);
		} catch (err) {
			host.emitError({
				extensionPath,
				event: "register_virtual_model",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		}
	}
	host.runtime.pendingVirtualModelRegistrations = [];

	// From this point on, provider registration/unregistration takes effect immediately
	// without requiring a /reload.
	host.runtime.registerProvider = (name, config) => {
		if (providerActions?.registerProvider) {
			providerActions.registerProvider(name, config);
			return;
		}
		host.modelRegistry.registerProvider(name, config);
	};
	host.runtime.registerNativeProvider = (provider) => {
		if (providerActions?.registerNativeProvider) {
			providerActions.registerNativeProvider(provider);
			return;
		}
		host.modelRegistry.registerProvider(provider);
	};
	host.runtime.unregisterProvider = (name) => {
		if (providerActions?.unregisterProvider) {
			providerActions.unregisterProvider(name);
			return;
		}
		host.modelRegistry.unregisterProvider(name);
	};
	host.runtime.registerVirtualModel = registerVirtualModel;
	host.runtime.unregisterVirtualModel = (provider, id) => {
		if (providerActions?.unregisterVirtualModel) providerActions.unregisterVirtualModel(provider, id);
		else host.modelRegistry.unregisterVirtualModel(provider, id);
	};
}

export function bindRunnerCommandContext(bindings: RunnerBindings, actions?: ExtensionCommandContextActions): void {
	if (actions) {
		bindings.waitForIdleFn = actions.waitForIdle;
		bindings.newSessionHandler = actions.newSession;
		bindings.forkHandler = actions.fork;
		bindings.navigateTreeHandler = actions.navigateTree;
		bindings.switchSessionHandler = actions.switchSession;
		bindings.reloadHandler = actions.reload;
		return;
	}

	bindings.waitForIdleFn = async () => {};
	bindings.newSessionHandler = async () => ({ cancelled: false });
	bindings.forkHandler = async () => ({ cancelled: false });
	bindings.navigateTreeHandler = async () => ({ cancelled: false });
	bindings.switchSessionHandler = async () => ({ cancelled: false });
	bindings.reloadHandler = async () => {};
}
