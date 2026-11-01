import type {
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Model, Tool } from "../../types.ts";
import { resolveLayeredCacheRetention } from "../../utils/cache-policy.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { splitSystemMessageAtBoundary } from "../../utils/instruction-split.ts";
import { getSystemMessageText } from "../../utils/text.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import { getCurrentTools, getInitialSystemMessage, type TranscriptContext } from "../../utils/transcript.ts";
import { transformMessages } from "../transform-messages.ts";
import { getAnthropicCompat, getLayeredCacheControl, shouldUseServerSideFallbackBeta } from "./compat.ts";
import { addHistoryLookbackBreakpoint, countCacheBreakpoints } from "./cache-breakpoints.ts";
import { buildCacheDiagnosticsParam } from "./cache-diagnostics.ts";
import { convertMessages, insertThinkingLevelMessages, normalizeToolCallId } from "./convert.ts";
import { convertTools, DEFERRED_TOOL_PLACEHOLDER } from "./tools.ts";
import type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./types.ts";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

function getBetaFeatures(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	isOAuthToken: boolean,
	nativeToolChanges: boolean,
	options?: AnthropicOptions,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	let configuredFeatures: string | null | undefined;
	for (const headers of [model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === "anthropic-beta") configuredFeatures = value;
		}
	}
	if (configuredFeatures === null) return [];
	if (configuredFeatures !== undefined) {
		return [
			...new Set(
				configuredFeatures
					.split(",")
					.map((feature) => feature.trim())
					.filter((feature) => feature.length > 0),
			),
		];
	}

	const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
	if (isOAuthToken) features.push("claude-code-20250219", "oauth-2025-04-20");
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

export function buildParams(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	disablePreferredStrictTools = false,
): {
	params: MessageCreateParamsStreaming;
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
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
	// Native tool changes keep the request-level tool list fixed and define every later tool
	// by value in a `tool_addition` block, which also expresses same-name redefinitions.
	// Anthropic rejects a tool list where every tool is deferred, so there must be an initial
	// active tool to anchor the placeholder. Otherwise the current tool list is sent.
	let hasPreferredStrictTools = false;
	const convertToolDefinitions = (tools: Tool[], toolCacheControl?: CacheControlEphemeral): BetaTool[] => {
		const definitions = convertTools(
			tools,
			isOAuthToken,
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
	// A second instruction block takes the tools-only marker's slot: the base block's marker already covers the
	// tools that precede it. Without an instruction marker or a usable boundary, the prompt stays one block.
	const splitSystem =
		instructionCacheControl && initialSystemMessage
			? splitSystemMessageAtBoundary(initialSystemMessage, options?.instructionCacheBoundary)
			: undefined;
	const thinkingDisabled =
		model.reasoning && options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	const thinks = thinksForRequest(model, options);
	// Effort cannot change between messages while thinking is disabled, so "off" sends no effort markers.
	const effortMessages = model.compat?.supportsMidConvoEffort === true && !thinkingDisabled;
	const converted = convertMessages(
		conversationMessages,
		isOAuthToken,
		cacheControl,
		compat.allowEmptySignature,
		effortMessages ? model.provider : undefined,
		nativeToolChanges ? convertToolDefinitions : undefined,
	);
	const activeEffort = options?.effort ?? "high";
	const betaFeatures = getBetaFeatures(model, context, isOAuthToken, nativeToolChanges, options);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: effortMessages ? insertThinkingLevelMessages(converted, activeEffort) : converted.messages,
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
		...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
	};
	const cacheDiagnostics = buildCacheDiagnosticsParam(model, context, options?.env);
	if (cacheDiagnostics) params.diagnostics = cacheDiagnostics;

	const promptBlocks = (splitSystem ?? [initialSystemText]).map((text) => ({
		type: "text" as const,
		text: sanitizeSurrogates(text),
		...(instructionCacheControl ? { cache_control: instructionCacheControl } : {}),
	}));
	// For OAuth tokens, we MUST include Claude Code identity. Only the prompt blocks are marked:
	// the prompt's breakpoint covers the identity line too, and a second marker would take the slot
	// the history lookback needs.
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(instructionCacheControl && !initialSystemText ? { cache_control: instructionCacheControl } : {}),
			},
			...(initialSystemText ? promptBlocks : []),
		];
	} else if (initialSystemText) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = promptBlocks;
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (
		options?.temperature !== undefined &&
		!thinks &&
		model.compat?.supportsMidConvoEffort !== true &&
		compat.supportsTemperature
	) {
		params.temperature = options.temperature;
	}

	const toolCacheControl = compat.supportsCacheControlOnTools && !splitSystem ? instructionCacheControl : undefined;
	if (nativeToolChanges) {
		// Initial tools stay active with the cache breakpoint on the last one, followed by the
		// placeholder. The list never changes afterwards: later tools are defined by value in
		// `tool_addition` blocks and withdrawn by `tool_removal`, so the cached prefix survives
		// every tool change.
		params.tools = [...convertToolDefinitions(initialTools, toolCacheControl), DEFERRED_TOOL_PLACEHOLDER];
	} else {
		const tools = getCurrentTools(context.messages);
		if (tools.length > 0) {
			params.tools = convertToolDefinitions(tools, toolCacheControl);
		}
	}

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
				budget_tokens: options?.thinkingBudgetTokens || 1024,
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
