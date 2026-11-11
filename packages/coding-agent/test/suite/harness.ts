import { createBashTool } from "../../src/core/tools/index.ts";
import type { CompactionSettings } from "../../src/core/compaction/compaction.ts";
import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@octocodeai/octocode-agent-core";
import { Agent } from "@octocodeai/octocode-agent-core";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
	ToolResultMessage,
} from "@octocodeai/octocode-ai/compat";
import { registerFauxProvider, streamSimple } from "@octocodeai/octocode-ai/compat";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner, ExtensionUIContext, InlineExtension } from "../../src/core/features/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { DEFAULT_TOOL_NAMES, SettingsManager } from "../../src/core/settings-manager.ts";
import type { ResourceLoader } from "../../src/core/resource-loader/types.ts";
import { theme } from "../../src/theme/theme.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

/** The latest result of `toolName` in the session transcript. */
export function getToolResult(harness: Harness, toolName: string): ToolResultMessage {
	const result = harness.session.messages.findLast(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	if (!result) throw new Error(`No ${toolName} tool result`);
	return result;
}

/** An extension UI context that does nothing, with `overrides` applied. */
export function createTestUiContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
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
		custom: async () => undefined,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		onEditorChange: () => () => {},
		setEditorSuggestion: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		...overrides,
	};
}

export interface HarnessOptions {
	provider?: string;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	compactionPolicy?: Partial<CompactionSettings>;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	builtinCompactionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	modelsJson?: Record<string, unknown>;
	/** Session to continue, for example to test a resume. Default: a new in-memory session. */
	sessionManager?: SessionManager;
	/** The session's working directory. Default: the harness's temporary directory. */
	cwd?: string;
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `octocode-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		provider: options.provider,
		models: options.models,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const tools = options.tools ?? (options.builtinCompactionFactories ? [createBashTool(tempDir)] : undefined);
	const toolMap = tools ? Object.fromEntries(tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	// Characterization runs against each model's whole window; tests of the default working context pass
	// `contextBudget: undefined` to use it.
	const settingsManager = SettingsManager.inMemory({ contextBudget: "full", ...options.settings });
	if (options.compactionPolicy) {
		const policy = { ...settingsManager.getCompactionSettings(model), ...options.compactionPolicy };
		settingsManager.getCompactionSettings = () => ({ ...policy });
		settingsManager.getCompactionEnabled = () => policy.enabled;
	}

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	const modelRegistry = modelsPath
		? await createModelRegistry(authStorage, modelsPath)
		: await createInMemoryModelRegistry(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		streamFn: streamSimple,
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
		},
		convertToLlm,
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const factories = options.builtinCompactionFactories ?? options.extensionFactories;
	const extensionsResult = factories ? await createTestExtensionsResult(factories, tempDir) : undefined;
	if (options.builtinCompactionFactories && extensionsResult) {
		for (const extension of extensionsResult.extensions) {
			extension.owner = "native";
			extension.sourceInfo.owner = "native";
		}
	}
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: options.cwd ?? tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames:
			options.initialActiveToolNames ??
			(options.builtinCompactionFactories ? (toolMap ? Object.keys(toolMap) : [...DEFAULT_TOOL_NAMES]) : undefined),
		usesDefaultTools: options.initialActiveToolNames === undefined && !options.builtinCompactionFactories,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			session.dispose();
			fauxProvider.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
