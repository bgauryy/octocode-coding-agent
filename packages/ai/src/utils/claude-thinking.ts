import type { Api, Model } from "../types.ts";
import { getProviderCapabilities } from "./provider-capabilities.ts";

/** Claude 5.5's effort limits also apply when OpenCode or Copilot forwards the Messages API. */
export function withClaudeThinkingCapabilities<T extends Model<Api>>(model: T): T {
	if (
		model.api !== "anthropic-messages" ||
		!model.reasoning ||
		!getProviderCapabilities(model.provider).claudeEffortLimits
	) {
		return model;
	}
	const family = /^claude-(opus|sonnet|haiku)-5[.-]5$/.exec(model.id)?.[1];
	if (!family) return model;
	// Opus and Sonnet reject disabled thinking; Haiku accepts it. "minimal" is not an effort level.
	// https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking
	// https://platform.claude.com/docs/en/build-with-claude/effort
	return {
		...model,
		thinkingLevelMap: {
			...model.thinkingLevelMap,
			...(family === "haiku" ? {} : { off: null }),
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	};
}
