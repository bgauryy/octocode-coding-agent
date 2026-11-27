/** The contexts handed to feature handlers, tools and commands, and the UI context used without a UI. */

import type { Theme } from "../../../theme/theme-class.ts";
import { theme } from "../../../theme/theme-global.ts";
import type { ExecuteToolOptions, CommandContext, FeatureContext, ToolContext, SessionUI } from "../types.ts";
import type { RunnerHost } from "./types.ts";

export const noOpUIContext: SessionUI = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingIndicator: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined,
	setEditorText: () => {},
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	onEditorChange: () => () => {},
	setEditorSuggestion: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
};

/**
 * Create an FeatureContext for use in event handlers and tool execution.
 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
 */
export function createFeatureContext(host: RunnerHost): FeatureContext {
	const getModel = host.bindings.getModel;
	const getScopedModels = host.bindings.getScopedModels;
	return {
		get ui() {
			host.assertActive();
			return host.uiContext;
		},
		get mode() {
			host.assertActive();
			return host.mode;
		},
		get hasUI() {
			host.assertActive();
			return host.hasUI();
		},
		get cwd() {
			host.assertActive();
			return host.cwd;
		},
		get sessionManager() {
			host.assertActive();
			return host.sessionManager;
		},
		get modelRegistry() {
			host.assertActive();
			return host.modelRegistry;
		},
		get model() {
			host.assertActive();
			return getModel();
		},
		get scopedModels() {
			host.assertActive();
			return getScopedModels();
		},
		get thinkingLevel() {
			host.assertActive();
			return host.runtime.getThinkingLevel();
		},
		get explicitToolNames() {
			host.assertActive();
			return host.bindings.getExplicitToolNames();
		},
		isIdle: () => {
			host.assertActive();
			return host.bindings.isIdleFn();
		},
		isProjectTrusted: () => {
			host.assertActive();
			return host.bindings.isProjectTrustedFn();
		},
		get signal() {
			host.assertActive();
			return host.bindings.getSignalFn();
		},
		abort: (reason) => {
			host.assertActive();
			host.bindings.abortFn(reason);
		},
		failRun: (reason) => {
			host.assertActive();
			host.bindings.failRunFn(reason);
		},
		hasPendingMessages: () => {
			host.assertActive();
			return host.bindings.hasPendingMessagesFn();
		},
		isMessageQueued: (details) => {
			host.assertActive();
			return host.bindings.isMessageQueuedFn(details);
		},
		replaceQueuedMessage: (details, content) => {
			host.assertActive();
			return host.bindings.replaceQueuedMessageFn(details, content);
		},
		shutdown: () => {
			host.assertActive();
			host.bindings.shutdownHandler();
		},
		getTurnId: () => {
			host.assertActive();
			return host.bindings.getTurnIdFn();
		},
		getContextUsage: () => {
			host.assertActive();
			return host.bindings.getContextUsageFn();
		},
		getCacheWarmingReport: () => {
			host.assertActive();
			return host.bindings.getCacheWarmingReportFn();
		},
		compact: (options) => {
			host.assertActive();
			host.bindings.compactFn(options);
		},
		requestBoundaryCompaction: (options) => {
			host.assertActive();
			host.bindings.requestBoundaryCompactionFn(options);
		},
		getSystemPrompt: () => {
			host.assertActive();
			return host.bindings.getSystemPromptFn();
		},
		getSystemPromptOptions: () => {
			host.assertActive();
			return host.bindings.getSystemPromptOptionsFn();
		},
	};
}

/**
 * Create the context for executing the tool call `toolCallId`: the feature context plus
 * `tools` and `executeTool()`. `signal` is the default signal of nested calls.
 */
export function createToolContext(host: RunnerHost, toolCallId: string, signal: AbortSignal | undefined): ToolContext {
	// createContext() returns a fresh object, so adding properties does not affect other contexts.
	return Object.defineProperties(host.createContext() as ToolContext, {
		tools: {
			get() {
				host.assertActive();
				return host.bindings.getCallableToolsFn();
			},
		},
		executeTool: {
			value: async (name: string, args: unknown, options: ExecuteToolOptions = {}) => {
				host.assertActive();
				if (!host.bindings.executeToolFn) {
					return {
						toolCall: { type: "toolCall", id: `${toolCallId}/0`, name, arguments: {} },
						result: {
							content: [{ type: "text", text: "Nested tool calls are not available in this context" }],
							details: {},
						},
						isError: true,
					};
				}
				return host.bindings.executeToolFn(toolCallId, name, args, { ...options, signal: options.signal ?? signal });
			},
		},
	});
}

export function createCommandContext(host: RunnerHost): CommandContext {
	// Use property descriptors instead of object spread so the guarded getters from
	// createContext() stay lazy. A spread would eagerly read them once and freeze the
	// old values into the returned object, bypassing stale-instance checks.
	const context = Object.defineProperties({}, Object.getOwnPropertyDescriptors(host.createContext())) as CommandContext;
	context.waitForIdle = () => {
		host.assertActive();
		return host.bindings.waitForIdleFn();
	};
	context.newSession = (options) => {
		host.assertActive();
		return host.bindings.newSessionHandler(options);
	};
	context.fork = (entryId, options) => {
		host.assertActive();
		return host.bindings.forkHandler(entryId, options);
	};
	context.navigateTree = (targetId, options) => {
		host.assertActive();
		return host.bindings.navigateTreeHandler(targetId, options);
	};
	context.switchSession = (sessionPath, options) => {
		host.assertActive();
		return host.bindings.switchSessionHandler(sessionPath, options);
	};
	context.reload = () => {
		host.assertActive();
		return host.bindings.reloadHandler();
	};
	return context;
}
