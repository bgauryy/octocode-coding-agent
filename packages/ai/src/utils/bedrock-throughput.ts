import type { Api, Model, Usage } from "../types.ts";

import { isBedrockKimi31 } from "./bedrock-models.ts";
import { isBedrockRuntimeHost } from "./provider-host.ts";

const KIMI_OUTPUT_BURNDOWN = 10;

/** Bedrock TPM output burndown: Kimi K3.1 counts each output token 10x; other models 1x. */
export function bedrockOutputBurndown(model: Model<Api>): number {
	return isBedrockKimi31(model) && (model.api === "bedrock-converse-stream" || isBedrockRuntimeHost(model.baseUrl))
		? KIMI_OUTPUT_BURNDOWN
		: 1;
}

/** Tokens to reserve before a call: uncached input plus the requested reply size, which Bedrock reserves at 1x. */
export function estimateBedrockAdmissionTokens(estimatedUncachedInput: number, maxTokens: number): number {
	return estimatedUncachedInput + maxTokens;
}

/** Tokens a finished call consumed against TPM: cache reads are excluded, output is scaled by burndown. */
export function bedrockQuotaTokens(model: Model<Api>, usage: Pick<Usage, "input" | "output" | "cacheWrite">): number {
	return usage.input + usage.cacheWrite + usage.output * bedrockOutputBurndown(model);
}
