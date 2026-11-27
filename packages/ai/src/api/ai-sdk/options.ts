import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Api, Model } from "../../types.ts";
import { nonZeroOr } from "../../utils/non-zero.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import type { GoogleBaseOptions } from "./google-options.ts";
import type { OpenAIResponsesOptions } from "../openai-responses/types.ts";

type SdkStreamOptions = AnthropicOptions & OpenAIResponsesOptions & Omit<GoogleBaseOptions, "toolChoice">;

export async function sdkProviderOptions(model: Model<Api>, options: SdkStreamOptions): Promise<ProviderOptions> {
	if (model.api.endsWith("responses")) {
		const openai = {
			store: false,
			forceReasoning: model.reasoning,
			...(options.reasoningEffort
				? { reasoningEffort: options.reasoningEffort, reasoningSummary: options.reasoningSummary ?? "auto" }
				: {}),
		};
		return { openai, azure: openai };
	}
	if (model.api === "anthropic-messages") {
		const disabled = model.reasoning && options.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
		const adaptive = (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
		const enabled = model.reasoning && (options.thinkingEnabled === true || adaptive);
		return {
			anthropic: disabled
				? { thinking: { type: "disabled" } }
				: enabled
					? {
							thinking: adaptive
								? { type: "adaptive", display: options.thinkingDisplay ?? "summarized" }
								: { type: "enabled", budgetTokens: nonZeroOr(1024, options.thinkingBudgetTokens) },
							...(options.effort ? { effort: options.effort } : {}),
						}
					: {},
		};
	}
	if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		if (!model.reasoning || !options.thinking) return {};
		const { getDisabledGoogleThinkingConfig } = await import("./google-thinking.ts");
		const config: { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number } = options.thinking
			.enabled
			? {
					includeThoughts: true,
					...(options.thinking.level
						? { thinkingLevel: options.thinking.level.toLowerCase() }
						: options.thinking.budgetTokens !== undefined
							? { thinkingBudget: options.thinking.budgetTokens }
							: {}),
				}
			: getDisabledGoogleThinkingConfig(model as Model<"google-generative-ai" | "google-vertex">);
		return {
			google: {
				thinkingConfig: {
					...config,
					...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel.toLowerCase() } : {}),
				},
			},
		};
	}
	return {};
}
