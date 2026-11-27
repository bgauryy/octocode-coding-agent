import type { Model, TranscriptContext } from "../../types.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import { getAnthropicCompat } from "../anthropic-messages/compat.ts";
import { getCurrentTools, getInitialSystemMessage } from "../../utils/transcript.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";

export function anthropicBetaHeader(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
): string | null {
	const compat = getAnthropicCompat(model);
	const features: string[] = [];
	if (getCurrentTools(context.messages).length && !compat.supportsEagerToolInputStreaming)
		features.push("fine-grained-tool-streaming-2025-05-14");
	if (
		model.reasoning &&
		(options.thinkingEnabled || (options.thinkingEnabled === false && model.thinkingLevelMap?.off === null)) &&
		(options.interleavedThinking ?? true) &&
		model.compat?.forceAdaptiveThinking !== true
	)
		features.push("interleaved-thinking-2025-05-14");
	if (model.compat?.allowedFallbackModels?.length) features.push("server-side-fallback-2026-07-01");
	if (model.compat?.supportsMidConvoEffort)
		features.push("mid-conversation-output-config-2026-07-01", "thinking-binding-controls-2026-08-01");
	if (
		resolveToolLoadingMode(model.api, compat) === "changes" &&
		getInitialSystemMessage(context.messages)?.toolsAdded?.length
	)
		features.push("inline-tools-2026-09-15");
	for (const headers of [model.headers, options.headers])
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() !== "anthropic-beta" || value === undefined) continue;
			if (value === null) features.length = 0;
			else
				features.push(
					...value
						.split(",")
						.map((feature) => feature.trim())
						.filter(Boolean),
				);
		}
	return [...new Set(features)].join(",") || null;
}
