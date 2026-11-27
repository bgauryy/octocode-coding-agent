import { McpServerRegistry } from "../../../../mcp/src/api.ts";
import type { FeatureRuntime } from "./types.ts";

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createFeatureRuntime(): FeatureRuntime {
	const notInitialized = () => {
		throw new Error("Feature runtime not initialized. Action methods cannot be called during feature loading.");
	};
	const state: { staleMessage?: string } = {};
	const eventBusUnsubscribers = new Set<() => void>();
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: FeatureRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		createUsageRecorder: notInitialized,
		recordUsage: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getHiddenDeclarations: notInitialized,
		getAllTools: notInitialized,
		getSettings: notInitialized,
		setActiveTools: notInitialized,
		selectsTools: notInitialized,
		setToolPolicy: notInitialized,
		// registerTool() is valid during feature load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		getSkillDirectories: notInitialized,
		getSkillResourceSnapshot: notInitialized,
		setModel: () => Promise.reject(new Error("Feature runtime not initialized")),
		getThinkingLevel: notInitialized,
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		mcpServers: new McpServerRegistry(),
		createContext: notInitialized,
		assertActive,
		invalidate: (message) => {
			if (state.staleMessage) return;
			state.staleMessage =
				message ??
				"This feature ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, source = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, source });
		},
		registerNativeProvider: (provider, source = "<unknown>") => {
			runtime.pendingNativeProviderRegistrations.push({ provider, source });
		},
	};

	return runtime;
}
