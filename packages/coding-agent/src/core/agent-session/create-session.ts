import { existsSync } from "node:fs";
import { Agent, setDefaultStreamFn, type ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Context, ModelsSimpleStreamOptions } from "@octocodeai/octocode-ai";
import { clampThinkingLevel, type Model, streamSimple } from "@octocodeai/octocode-ai/compat";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { createToolNameMatcher } from "@octocodeai/octocode-common/mcp-names";
import { AgentSession } from "../agent-session.ts";
import type { AgentSessionServices } from "../agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "../auth-guidance.ts";
import { sessionPromptCacheKey } from "../cache-key-group.ts";
import { CacheWarmer } from "../cache-warmer.ts";
import { IdleContinuationPool } from "../cache-warmer/idle-pool.ts";
import { agentDbIdleGapStore } from "../cache-warmer/idle-pool-store.ts";
import { DEFAULT_THINKING_LEVEL } from "../defaults.ts";
import type { FeatureHost, LoadedFeatures, SessionStartEvent, ToolDefinition } from "../features/index.ts";
import { findInitialModel } from "../model-resolver.ts";
import type { RuntimeSimpleStreamOptions } from "../model-runtime/requests.ts";
import { defaultToolNames as getDefaultToolNames } from "../native-tools.ts";
import { mergeProviderAttributionHeaders } from "../provider-attribution.ts";
import type { SessionManager } from "../session-manager.ts";
import { applyToolModifiers, getToolListError, isToolModifier } from "../settings-manager.ts";
import { getBranchSelection, isVirtualModel } from "../virtual-models.ts";
import { createConvertToLlmWithBlockImages } from "./block-images.ts";
import { withRequestTrace } from "./request-trace.ts";
import { listenerErrorReporter } from "../listener-diagnostics.ts";

/** Session inputs resolved against already-created, cwd-bound services. */
export interface CreateSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	/** Session start event metadata for feature runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Model to use. Default: restored from the session, else from settings, else the first available. */
	model?: Model<any>;
	/** Thinking level. Default: from the session or settings, clamped to model capabilities. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * No one watches the run (print mode, an ACP server's session): when no model is named, restored or set as the
	 * default, the automatic choice skips plans that allow interactive use only (`findInitialModel`).
	 */
	unattended?: boolean;
	/** Models available for cycling (Ctrl+P in interactive mode). */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/**
	 * Default tool suppression when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in Octocode tools but keep feature and custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Allowlist of tool names or patterns, where `*` matches any characters.
	 *
	 * When omitted, the `defaultTools` setting selects the initial tools when configured; otherwise the default
	 * built-in tools of the loaded runtime are enabled, including native Octocode tools. Feature and custom tools
	 * remain enabled unless `noTools` changes that default. When provided, only matching tools are enabled, MCP tools
	 * included; an MCP server whose tools no entry can match is not started. An empty list, like `noTools: "all"`,
	 * disables MCP tools too.
	 *
	 * A list of only `+name` and `-name` entries is not an allowlist: it adds tools to or removes them from the
	 * default selection, like the `defaultTools` setting. These entries take exact names. Mixing them with plain
	 * entries throws.
	 */
	tools?: string[];
	/** Denylist of tool names or patterns to disable. Applies after `tools` when both are provided, MCP tools included. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];
}

export interface CreateSessionResult {
	session: AgentSession;
	/** Features result (for UI context setup in interactive mode). */
	featuresResult: LoadedFeatures;
	/** Warning if the session was restored with a different model than saved. */
	modelFallbackMessage?: string;
}

// Preserve the pre-0.81 fallback for code that constructs Agent instances or invokes low-level
// agent loops without supplying streamFn. Agent core remains provider-agnostic and does not
// import octocode-ai/compat itself.
setDefaultStreamFn(streamSimple);

/**
 * Create an AgentSession from previously created services.
 *
 * Session creation stays separate from service creation so callers can resolve model, thinking, tools
 * and other session inputs against the target cwd before constructing the session.
 */
export async function createSessionFromServices(
	options: CreateSessionFromServicesOptions,
): Promise<CreateSessionResult> {
	const { cwd, modelRuntime, settingsManager, resourceLoader } = options.services;
	const { sessionManager } = options;

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
		const restoredModel = modelRuntime
			.getAvailableSnapshot()
			.find((candidate) => candidate.provider === sessionModel.provider && candidate.id === sessionModel.modelId);
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
			providerModels: settingsManager.getProviderModels(),
			unattended: options.unattended,
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
	thinkingLevel ??= settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel);
	}

	const tools = options.tools;
	const toolListError = tools ? getToolListError(tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const builtinDefaults = getDefaultToolNames(resourceLoader.getFeatures().features);
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools(builtinDefaults) ?? builtinDefaults);
	// A `tools` list of only `+name`/`-name` entries changes the default selection instead of
	// replacing it, like the `defaultTools` setting.
	const toolModifiers = tools?.some(isToolModifier) ? tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : tools;
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = createConvertToLlmWithBlockImages(settingsManager);

	const featureHostRef: { current?: FeatureHost } = {};
	// A main session's idle gaps join the pool every session's warmer reads; a subagent's follow its coordinator.
	const subagent = envFlag(process.env, SUBAGENT_ENV);
	const idleGaps = new IdleContinuationPool(agentDbIdleGapStore(), (error) =>
		listenerErrorReporter(() => featureHostRef.current, "agent")(
			`Idle-gap statistics unavailable: ${error instanceof Error ? error.message : String(error)}`,
			error,
		),
	);
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => featureHostRef.current?.emitCacheWarmingDecision(event) ?? event.action,
		{ pool: idleGaps, recordGaps: !subagent },
	);
	const promptCacheKey = sessionPromptCacheKey(sessionManager, cwd);
	const buildRequestOptions = (
		requestModel: Model<any>,
		options: ModelsSimpleStreamOptions = {},
		context?: Context,
	): RuntimeSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const resolveCache = (physical: Model<any>) =>
			modelRuntime.getCachePolicy(physical, options, settingsManager.getCachePreferenceLayers()).options;
		return {
			...options,
			roleVariantTools: new Set(agent.state.tools.filter((tool) => tool.roleVariant).map((tool) => tool.name)),
			promptCacheKey: options.promptCacheKey ?? promptCacheKey(requestModel, options.sessionId, context),
			// A virtual model's request is resolved for the model it routes to.
			...(isVirtualModel(requestModel) ? { resolveCache } : resolveCache(requestModel)),
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			// One setting bounds silence on both layers: the HTTP dispatcher's body timeout and the provider stream reader.
			streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? httpIdleTimeoutMs,
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			transformHeaders: async (requestHeaders) =>
				mergeProviderAttributionHeaders(requestModel, settingsManager, options.sessionId, requestHeaders) ?? {},
		};
	};
	// Warm only requests for the selected model. Requests a virtual selection routed, or that an
	// feature redirected, may not be repeated by the next request, so warming them could be wasted.
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
			const requestOptions = buildRequestOptions(model, options, context);
			// Compaction and summaries use their own routing ids; only session requests
			// replace the cache entry, so warming restarts from them. Keep warming while
			// the current transcript still extends the request's prefix. Agent state may
			// shallow-copy the messages array or refresh the model object without changing
			// the provider request, so top-level object identity is not a valid cache key.
			if (options?.sessionId === sessionManager.getSessionId())
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			return withRequestTrace(requestOptions, (traced) => modelRuntime.streamSimple(model, context, traced));
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = featureHostRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		onListenerError: listenerErrorReporter(() => featureHostRef.current, "agent"),
	});
	resourceLoader.reportHandlerErrorsTo?.(listenerErrorReporter(() => featureHostRef.current, "event bus"));

	// Restore missing settings metadata for older sessions, and record a level the caller chose on resume so a later
	// reopen keeps it. A restored level that was only clamped to another model stays unrecorded.
	if (hasExistingSession) {
		const chosen = options.thinkingLevel !== undefined && thinkingLevel !== existingSession.thinkingLevel;
		if (!hasThinkingEntry || chosen) {
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
		requestedThinkingLevel: options.thinkingLevel,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		featureHostRef,
		sessionStartEvent: options.sessionStartEvent ?? {
			type: "session_start",
			reason: resumedSession ? "resume" : "startup",
		},
	});

	const featuresResult = resourceLoader.getFeatures();

	return {
		session,
		featuresResult,
		modelFallbackMessage,
	};
}
