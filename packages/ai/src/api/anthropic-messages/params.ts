import type {
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Model, Tool } from "../../types.ts";
import { resolveLayeredCacheRetention } from "../../utils/cache-policy.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { keepsToolBreakpoint, splitSystemMessageIntoBlocks } from "../../utils/instruction-split.ts";
import { getSystemMessageText } from "../../utils/text.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import { getCurrentTools, getInitialSystemMessage, type TranscriptContext } from "../../utils/transcript.ts";
import { transformMessages } from "../transform-messages.ts";
import { DEFAULT_ANTHROPIC_VERSION } from "./client.ts";
import { getAnthropicCompat, getLayeredCacheControl, shouldUseServerSideFallbackBeta } from "./compat.ts";
import { addHistoryLookbackBreakpoint, countCacheBreakpoints } from "./cache-breakpoints.ts";
import { buildCacheDiagnosticsParam } from "./cache-diagnostics.ts";
import { convertMessages, insertThinkingLevelMessages } from "./convert.ts";
import { fitToolCallId } from "../tool-call-id.ts";
import { convertTools, DEFERRED_TOOL_PLACEHOLDER } from "./tools.ts";
import type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./types.ts";
import { nonZeroOr } from "../../utils/non-zero.ts";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

/** API versions from this date reject temperature, top_p and top_k. */
const SAMPLING_REMOVED_API_VERSION = "2026-10-21";

function acceptsSamplingParameters(model: Model<"anthropic-messages">, options?: AnthropicOptions): boolean {
	let version: string | null | undefined = DEFAULT_ANTHROPIC_VERSION;
	for (const headers of [model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === "anthropic-version") version = value;
		}
	}
	// Versions are ISO dates, so string order is date order.
	return !version || version < SAMPLING_REMOVED_API_VERSION;
}

function getBetaFeatures(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	nativeToolChanges: boolean,
	options?: AnthropicOptions,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	// Configured betas add to the ones Octocode needs; a `null` header drops every beta set before it, Octocode's too.
	let configuredFeatures: string[] = [];
	let ownFeaturesDropped = false;
	for (const headers of [model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() !== "anthropic-beta" || value === undefined) continue;
			if (value === null) {
				configuredFeatures = [];
				ownFeaturesDropped = true;
				continue;
			}
			for (const feature of value.split(",")) {
				if (feature.trim().length > 0) configuredFeatures.push(feature.trim());
			}
		}
	}
	const ownFeatures = ownFeaturesDropped ? [] : getOwnBetaFeatures(model, context, nativeToolChanges, options);
	return [...new Set([...ownFeatures, ...configuredFeatures])];
}

function getOwnBetaFeatures(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	nativeToolChanges: boolean,
	options?: AnthropicOptions,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
	if (shouldUseFineGrainedToolStreamingBeta(model, context)) features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	if (
		thinksForRequest(model, options) &&
		(options?.interleavedThinking ?? true) &&
		model.compat?.forceAdaptiveThinking !== true
	) {
		features.push(INTERLEAVED_THINKING_BETA);
	}
	if (shouldUseServerSideFallbackBeta(model)) features.push(SERVER_SIDE_FALLBACK_BETA);
	if (model.compat?.supportsMidConvoEffort === true) {
		features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
	}
	if (nativeToolChanges) features.push(INLINE_TOOLS_BETA);
	return [...new Set(features)];
}

/**
 * The SDK's types stopped declaring `temperature` with API version 2026-10-21. Requests pin an older version, which still
 * accepts it, and the SDK sends unknown body fields unchanged.
 */
export type AnthropicRequestParams = MessageCreateParamsStreaming & { temperature?: number };

export function buildParams(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: AnthropicOptions,
	disablePreferredStrictTools = false,
): {
	params: AnthropicRequestParams;
	hasPreferredStrictTools: boolean;
	/** Effort of the final effort marker, recorded on the reply so later requests can replay it. */
	providerThinkingLevel: AnthropicEffort | undefined;
} {
	const { instructions: instructionCacheControl, history: cacheControl } = getLayeredCacheControl(
		model,
		resolveLayeredCacheRetention(options),
		options?.env,
	);
	const compat = getAnthropicCompat(model);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const transformedMessages = transformMessages(context.messages, model, (id) => fitToolCallId(id));
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
	// Native tool changes keep the request-level tool list fixed and define every later tool
	// by value in a `tool_addition` block, which also expresses same-name redefinitions.
	// Anthropic rejects a tool list where every tool is deferred, so there must be an initial
	// active tool to anchor the placeholder. Otherwise the current tool list is sent.
	let hasPreferredStrictTools = false;
	const convertToolDefinitions = (tools: Tool[], toolCacheControl?: CacheControlEphemeral): BetaTool[] => {
		const definitions = convertTools(
			tools,
			compat.supportsEagerToolInputStreaming,
			compat.supportsStrictTools,
			toolCacheControl,
			disablePreferredStrictTools,
		);
		if (
			definitions.some((definition, index) => {
				const config = tools[index].constrainedSampling;
				return definition.strict === true && config && config.type === "json_schema" && config.strict === "prefer";
			})
		) {
			hasPreferredStrictTools = true;
		}
		return definitions;
	};
	const initialTools = initialSystemMessage?.toolsAdded ?? [];
	const nativeToolChanges = resolveToolLoadingMode(model.api, compat) === "changes" && initialTools.length > 0;
	// A second cached instruction block takes the tools-only marker's slot: the base block's marker already covers the
	// tools that precede it. The volatile block carries no marker, so the request holds at most four: two on the
	// instructions (or one and the tools), the last message and the lookback. Without an instruction marker or a
	// usable boundary, the prompt stays one block.
	const splitSystem =
		instructionCacheControl && initialSystemMessage
			? splitSystemMessageIntoBlocks(
					initialSystemMessage,
					options?.instructionCacheBoundary,
					options?.instructionVolatileBoundary,
				)
			: undefined;
	const thinkingDisabled =
		model.reasoning && options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	const thinks = thinksForRequest(model, options);
	// Effort cannot change between messages while thinking is disabled, so "off" sends no effort markers.
	const effortMessages = model.compat?.supportsMidConvoEffort === true && !thinkingDisabled;
	const converted = convertMessages(
		conversationMessages,
		cacheControl,
		compat.allowEmptySignature,
		effortMessages ? model.provider : undefined,
		nativeToolChanges ? convertToolDefinitions : undefined,
	);
	const activeEffort = options?.effort ?? "high";
	const betaFeatures = getBetaFeatures(model, context, nativeToolChanges, options);
	const params: AnthropicRequestParams = {
		model: model.id,
		messages: effortMessages ? insertThinkingLevelMessages(converted, activeEffort) : converted.messages,
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
		...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
	};
	const cacheDiagnostics = buildCacheDiagnosticsParam(model, context, options?.env);
	if (cacheDiagnostics) params.diagnostics = cacheDiagnostics;

	// The tool prefix every agent role declares alike gets its own instruction marker, so a child of one role reads the
	// prefix another role wrote. It takes the slot of the marker that would follow it: the last tool's, or the base
	// block's when the prompt has two cached blocks (the session block's marker still covers the base block).
	const sentTools = nativeToolChanges ? initialTools : getCurrentTools(context.messages);
	const sharedToolEnd =
		instructionCacheControl && compat.supportsCacheControlOnTools
			? sharedToolPrefix(sentTools, options?.toolCacheBoundary)
			: 0;
	const unmarkedBase = sharedToolEnd > 0 && (splitSystem?.cached.length ?? 0) > 1;
	const promptBlock = (text: string, cached: boolean) => ({
		type: "text" as const,
		text: sanitizeSurrogates(text),
		...(cached && instructionCacheControl ? { cache_control: instructionCacheControl } : {}),
	});
	const promptBlocks = splitSystem
		? [
				...splitSystem.cached.map((text, index) => promptBlock(text, !(unmarkedBase && index === 0))),
				...(splitSystem.volatile === undefined ? [] : [promptBlock(splitSystem.volatile, false)]),
			]
		: [promptBlock(initialSystemText, true)];
	if (initialSystemText) params.system = promptBlocks;

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (
		options?.temperature !== undefined &&
		!thinks &&
		model.compat?.supportsMidConvoEffort !== true &&
		compat.supportsTemperature &&
		acceptsSamplingParameters(model, options)
	) {
		params.temperature = options.temperature;
	}

	const toolCacheControl =
		compat.supportsCacheControlOnTools && keepsToolBreakpoint(splitSystem) && sharedToolEnd === 0
			? instructionCacheControl
			: undefined;
	if (nativeToolChanges) {
		// Initial tools stay active with the cache breakpoint on the last one, followed by the
		// placeholder. The list never changes afterwards: later tools are defined by value in
		// `tool_addition` blocks and withdrawn by `tool_removal`, so the cached prefix survives
		// every tool change.
		params.tools = [...convertToolDefinitions(initialTools, toolCacheControl), DEFERRED_TOOL_PLACEHOLDER];
	} else if (sentTools.length > 0) {
		params.tools = convertToolDefinitions(sentTools, toolCacheControl);
	}
	if (sharedToolEnd > 0 && params.tools) params.tools[sharedToolEnd - 1].cache_control = instructionCacheControl;

	if (cacheControl) {
		addHistoryLookbackBreakpoint(
			params.messages,
			cacheControl,
			countCacheBreakpoints([params.system, params.tools, params.messages]),
		);
	}

	if (thinkingDisabled) {
		// No effort is sent, so the model default applies. Anthropic rejects `block_binding`
		// with disabled thinking.
		params.thinking = { type: "disabled" };
	} else if (effortMessages) {
		// Managed effort models use adaptive thinking so prefix mismatches can
		// be dropped instead of surfacing as persistent 400 responses.
		params.thinking = {
			type: "adaptive",
			display: options?.thinkingDisplay ?? "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		};
		params.output_config = { effort: "high" };
	} else if (thinks) {
		// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
		// older Claude 4 models (whose API default is also "summarized").
		const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
		if (model.compat?.forceAdaptiveThinking === true) {
			// Adaptive thinking: Claude decides when and how much to think. A model that cannot turn
			// thinking off still gets the requested (least) effort here instead of the model default.
			params.thinking = { type: "adaptive", display };
			if (options?.effort) {
				params.output_config = { effort: options.effort };
			}
		} else {
			// Budget-based thinking for older models
			params.thinking = {
				type: "enabled",
				budget_tokens: nonZeroOr(1024, options?.thinkingBudgetTokens),
				display,
			};
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const allowedFallbackModels = model.compat?.allowedFallbackModels;
	if (allowedFallbackModels && allowedFallbackModels.length > 0) {
		params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
	}

	return { params, hasPreferredStrictTools, providerThinkingLevel: effortMessages ? activeEffort : undefined };
}

/** How many leading tools end before `boundary` (the first role-specific tool), or 0 when it names none after the first. */
function sharedToolPrefix(tools: readonly Tool[], boundary: string | undefined): number {
	if (!boundary) return 0;
	return Math.max(
		0,
		tools.findIndex((tool) => tool.name === boundary),
	);
}

/** Whether the request thinks: requested, or forced because the model cannot turn thinking off (`off: null`). */
function thinksForRequest(model: Model<"anthropic-messages">, options: AnthropicOptions | undefined): boolean {
	if (!model.reasoning) return false;
	if (options?.thinkingEnabled === true) return true;
	return options?.thinkingEnabled === false && model.thinkingLevelMap?.off === null;
}

function shouldUseFineGrainedToolStreamingBeta(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
): boolean {
	return getCurrentTools(context.messages).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}
