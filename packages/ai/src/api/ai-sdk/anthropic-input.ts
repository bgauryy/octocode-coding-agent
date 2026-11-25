import { jsonSchema, tool } from "ai";
import type { Model, TranscriptContext } from "../../types.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import { getAnthropicCompat } from "../anthropic-messages/compat.ts";
import { getCurrentTools, getInitialSystemMessage } from "../../utils/transcript.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import { nonZeroOr } from "../../utils/non-zero.ts";
import { anthropicSdkTools } from "./anthropic-map.ts";
import { anthropicSdkMessages } from "./anthropic-messages.ts";
import { anthropicSdkCache } from "./anthropic-cache.ts";
import { buildCacheDiagnosticsParam } from "../anthropic-messages/cache-diagnostics.ts";
import { preserveAnthropicBoundaries } from "./anthropic-boundaries.ts";
import { anthropicSdkEvents } from "./anthropic-events.ts";
import { vercelGatewayOptions } from "../anthropic-messages/gateway-routing.ts";
import { capCacheBreakpoints } from "../anthropic-messages/cache-breakpoints.ts";
import { CACHE_PROFILES } from "../../utils/cache-profiles.ts";
import { requestDiagnostics } from "./request-diagnostics.ts";
import type { SdkMapping } from "./stream.ts";

export function anthropicSdkInput(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions = {},
	disablePreferredStrictTools = false,
): SdkMapping {
	const compat = getAnthropicCompat(model);
	const initialTools = getInitialSystemMessage(context.messages)?.toolsAdded ?? [];
	const inline = resolveToolLoadingMode(model.api, compat) === "changes" && initialTools.length > 0;
	const definitions = inline ? initialTools : getCurrentTools(context.messages);
	const tools = anthropicSdkTools(definitions, compat.supportsStrictTools, disablePreferredStrictTools);
	for (const definition of Object.values(tools))
		definition.providerOptions = { anthropic: { eagerInputStreaming: compat.supportsEagerToolInputStreaming } };
	if (inline)
		tools.__octocode_deferred_placeholder__ = tool({
			description: "Reserved placeholder. Never available. Never call this.",
			inputSchema: jsonSchema({ type: "object", properties: {}, required: [] }),
			providerOptions: { anthropic: { deferLoading: true } },
		});
	const messages = anthropicSdkMessages(model, context, options, inline, disablePreferredStrictTools);
	const diagnostics = requestDiagnostics();
	const longCache = anthropicSdkCache(model, context, options, messages, tools, diagnostics);
	const disabled = model.reasoning && options.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	const thinks =
		model.reasoning &&
		(options.thinkingEnabled === true || (options.thinkingEnabled === false && model.thinkingLevelMap?.off === null));
	const managed = model.compat?.supportsMidConvoEffort === true && !disabled;
	const thinking = disabled
		? { type: "disabled" }
		: managed || (thinks && model.compat?.forceAdaptiveThinking === true)
			? {
					type: "adaptive",
					display: options.thinkingDisplay ?? "summarized",
					...(managed ? { blockBinding: { prefixMismatchBehavior: "drop_block" } } : {}),
				}
			: thinks
				? { type: "enabled", budgetTokens: nonZeroOr(1024, options.thinkingBudgetTokens) }
				: undefined;
	const choice = options.toolChoice;
	const events = anthropicSdkEvents(model, options, longCache);
	return {
		messages,
		tools,
		providerOptions: {
			anthropic: {
				...(thinking ? { thinking } : {}),
				...(managed ? { effort: "high" } : thinks && options.effort ? { effort: options.effort } : {}),
				toolStreaming: compat.supportsEagerToolInputStreaming,
				...(typeof options.metadata?.user_id === "string" ? { metadata: { userId: options.metadata.user_id } } : {}),
				...(model.compat?.allowedFallbackModels?.length
					? { fallbacks: model.compat.allowedFallbackModels.map((fallback) => ({ model: fallback.model })) }
					: {}),
			},
		},
		toolChoice:
			typeof choice === "object" ? { type: "tool", toolName: choice.name } : choice === "any" ? "required" : choice,
		includeRawChunks: true,
		finalizeRequest: (body) => {
			if (body && typeof body === "object") (body as Record<string, unknown>).stream = true;
		},
		onPart: (part, output, stream) => {
			if (part.type === "finish" || part.type === "error") diagnostics.flush(output);
			return events(part, output, stream);
		},
		augmentRequest: (body) => {
			preserveAnthropicBoundaries(body, messages);
			const removed = capCacheBreakpoints(body, CACHE_PROFILES.anthropic.maxMarkers);
			if (removed > 0)
				diagnostics.report("cache_markers_capped", {
					removed,
					max: CACHE_PROFILES.anthropic.maxMarkers,
					model: model.id,
				});
			for (const message of (body.messages ?? []) as { content?: unknown }[])
				if (Array.isArray(message.content))
					for (const part of message.content as Record<string, unknown>[])
						if (part.type === "tool_result" && part.is_error === undefined) part.is_error = false;
			const gateway = vercelGatewayOptions(model, options);
			if (gateway) body.providerOptions = { ...(body.providerOptions as object | undefined), gateway };
			const cacheDiagnostics = buildCacheDiagnosticsParam(model, context, options.env);
			if (cacheDiagnostics) body.diagnostics = cacheDiagnostics;
			// SDK model catalog defaults must not override explicit compatibility policy.
			if (thinking) {
				if (thinking.type === "enabled")
					body.thinking = {
						type: "enabled",
						budget_tokens: options.thinkingBudgetTokens ?? 1024,
						display: options.thinkingDisplay ?? "summarized",
					};
				else if (disabled) body.thinking = { type: "disabled" };
			} else delete body.thinking;
			let version: string | null = "2023-06-01";
			for (const headers of [model.headers, options.headers])
				for (const [name, value] of Object.entries(headers ?? {}))
					if (name.toLowerCase() === "anthropic-version" && value !== undefined) version = value;
			if (
				options.temperature !== undefined &&
				!thinks &&
				!managed &&
				compat.supportsTemperature &&
				(!version || version < "2026-10-21")
			)
				body.temperature = options.temperature;
			else delete body.temperature;
		},
	};
}
