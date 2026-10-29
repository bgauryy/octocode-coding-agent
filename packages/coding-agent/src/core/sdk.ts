import { existsSync } from "node:fs";
import { join } from "node:path";
import { Agent, setDefaultStreamFn, type ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { ModelsSimpleStreamOptions } from "@octocodeai/octocode-ai";
import { clampThinkingLevel, type Model, streamSimple } from "@octocodeai/octocode-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { IdleHistoryCache } from "./idle-cache-retention.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { createToolNameMatcher } from "../../../mcp/src/servers.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import type { RuntimeSimpleStreamOptions } from "./model-runtime/requests.ts";
import { defaultToolNames as getDefaultToolNames } from "./native-tools.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { createConvertToLlmWithBlockImages } from "./sdk/block-images.ts";
import { createProviderHooks } from "./sdk/provider-hooks.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "./sdk/types.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { applyToolModifiers, getToolListError, isToolModifier, SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import { getBranchSelection, isVirtualModel } from "./virtual-models.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import octocode-ai/compat itself.
setDefaultStreamFn(streamSimple);

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getBuiltinModel } from '@octocodeai/octocode-ai/providers/all';
 * const { session } = await createAgentSession({
 *   model: getBuiltinModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const sessionFile = sessionManager.getSessionFile();
	const resumedSession = hasExistingSession || !!(sessionFile && existsSync(sessionFile));
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// Assistant messages name the physical model that answered, so a virtual selection is only in
	// model_change entries.
	const sessionModel = getBranchSelection(sessionManager.getBranch(), (provider, modelId) =>
		modelRuntime.getModel(provider, modelId),
	);

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && sessionModel) {
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel);
	}

	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const builtinDefaults = getDefaultToolNames(resourceLoader.getExtensions().extensions);
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools(builtinDefaults) ?? builtinDefaults);
	// A `tools` list of only `+name`/`-name` entries changes the default selection instead of
	// replacing it, like the `defaultTools` setting.
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = createConvertToLlmWithBlockImages(settingsManager);

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	const idleHistoryCache = new IdleHistoryCache();
	const buildRequestOptions = (
		requestModel: Model<any>,
		options: ModelsSimpleStreamOptions = {},
	): RuntimeSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		// Only session requests measure idle gaps and move to the long tier; compaction and summaries use other ids.
		const sessionRequest = options.sessionId === sessionManager.getSessionId();
		const resolveCache = (physical: Model<any>) => {
			const policy = modelRuntime.getCachePolicy(physical, options, settingsManager.getCachePreferenceLayers());
			return sessionRequest ? idleHistoryCache.apply(physical, policy) : policy.options;
		};
		return {
			...options,
			// A virtual model's request is resolved for the model it routes to.
			...(isVirtualModel(requestModel) ? { resolveCache } : resolveCache(requestModel)),
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			transformHeaders: async (requestHeaders) => {
				const headers = mergeProviderAttributionHeaders(
					requestModel,
					settingsManager,
					options.sessionId,
					requestHeaders,
				);
				return headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers ?? {})
					: (headers ?? {});
			},
		};
	};
	// Warm only requests for the selected model. Requests a virtual selection routed, or that an
	// extension redirected, may not be repeated by the next request, so warming them could be wasted.
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = agent.state.messages;
		const systemPrompt = agent.state.systemPrompt;
		const toolSnapshot = () =>
			JSON.stringify(agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
		const tools = toolSnapshot();
		const sessionId = sessionManager.getSessionId();
		const thinkingLevel = agent.state.thinkingLevel;
		const cachePreferences = JSON.stringify(settingsManager.getCachePreferences());
		return () => {
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
			return (
				!extensionRunnerRef.current?.hasHandlers("before_provider_request") &&
				sessionManager.getSessionId() === sessionId &&
				agent.state.thinkingLevel === thinkingLevel &&
				JSON.stringify(settingsManager.getCachePreferences()) === cachePreferences &&
				currentModel.api === requestModel.api &&
				currentModel.baseUrl === requestModel.baseUrl &&
				agent.state.systemPrompt === systemPrompt &&
				toolSnapshot() === tools &&
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const { transformProviderPayload, handleProviderResponse, handleProviderStreamEvent } =
		createProviderHooks(extensionRunnerRef);

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingSession.messages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const requestOptions = buildRequestOptions(model, options);
			// Compaction and summaries use their own routing ids; only session requests
			// replace the cache entry, so warming restarts from them. Keep warming while
			// the current transcript still extends the request's prefix. Agent state may
			// shallow-copy the messages array or refresh the model object without changing
			// the provider request, so top-level object identity is not a valid cache key.
			if (options?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		onPayload: transformProviderPayload,
		onResponse: handleProviderResponse,
		onProviderStreamEvent: handleProviderStreamEvent,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore missing settings metadata for older sessions.
	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent ?? {
			type: "session_start",
			reason: resumedSession ? "resume" : "startup",
		},
	});

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
