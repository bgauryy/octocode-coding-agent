import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Usage } from "../../types.ts";

// The API can return newer tier names before the installed SDK adds them.
type ServiceTier = ResponseCreateParamsStreaming["service_tier"] | "ultrafast" | undefined;

/** OpenAI bills every token class at the tier rate. GPT-6 models report Fast mode as "fast". */
function getServiceTierCostMultiplier(model: { id: string }, serviceTier: ServiceTier): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "ultrafast":
			return 6;
		case "priority":
		case "fast":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

/** Scales a calculated cost by the service tier the response was served at. Shared by Responses and Codex. */
export function applyServiceTierPricing(usage: Usage, serviceTier: ServiceTier, model: { id: string }): void {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
