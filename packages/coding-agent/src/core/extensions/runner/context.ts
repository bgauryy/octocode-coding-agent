/** The contexts handed to extension handlers, tools and commands, and the UI context used without a UI. */

import { type Theme, theme } from "../../../theme/theme.ts";
import type {
	ExecuteToolOptions,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
} from "../types.ts";
import type { RunnerHost } from "./types.ts";

export const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

/**
 * Create an ExtensionContext for use in event handlers and tool execution.
 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
 */
export function createExtensionContext(host: RunnerHost): ExtensionContext {
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
		hasPendingMessages: () => {
			host.assertActive();
			return host.bindings.hasPendingMessagesFn();
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
		compact: (options) => {
			host.assertActive();
			host.bindings.compactFn(options);
		},
		getSystemPrompt: () => {
			host.assertActive();
			return host.bindings.getSystemPromptFn();
		},
	};
}

/**
 * Create the context for executing the tool call `toolCallId`: the extension context plus
 * `tools` and `executeTool()`. `signal` is the default signal of nested calls.
 */
export function createExtensionToolContext(
	host: RunnerHost,
	toolCallId: string,
	signal: AbortSignal | undefined,
): ExtensionToolContext {
	// createContext() returns a fresh object, so adding properties does not affect other contexts.
	return Object.defineProperties(host.createContext() as ExtensionToolContext, {
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

export function createExtensionCommandContext(host: RunnerHost): ExtensionCommandContext {
	// Use property descriptors instead of object spread so the guarded getters from
	// createContext() stay lazy. A spread would eagerly read them once and freeze the
	// old values into the returned object, bypassing stale-instance checks.
	const context = Object.defineProperties(
		{},
		Object.getOwnPropertyDescriptors(host.createContext()),
	) as ExtensionCommandContext;
	context.getSystemPromptOptions = () => {
		host.assertActive();
		return host.bindings.getSystemPromptOptionsFn();
	};
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
