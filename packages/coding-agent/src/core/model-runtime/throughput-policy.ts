/** Conservative Bedrock/Kimi capacity and request-priority policy for the shared throughput gate. */

import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type Api, type Model, type RequestPriority, type TranscriptContext } from "@octocodeai/octocode-ai";
import { bedrockOutputBurndown } from "@octocodeai/octocode-ai/utils/bedrock-throughput";
import { estimateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { isBedrockInferenceHost } from "@octocodeai/octocode-ai/utils/provider-host";

/** Half of AWS's published 1M global/cross-region Kimi K3.1 TPM quota, leaving headroom for other account consumers. */
const DEFAULT_KIMI_TOKENS_PER_MINUTE = 500_000;
/** AWS publishes no Kimi K3.1 RPM entry; this is a local safety cap, not a claimed Service Quota. */
const DEFAULT_KIMI_REQUESTS_PER_MINUTE = 60;
export const THROUGHPUT_WINDOW_MS = 60_000;

export interface ThroughputPolicy {
	key: string;
	region?: string;
	tokensPerMinute: number;
	requestsPerMinute: number;
	outputBurndown: number;
}

function positiveLimit(name: string, value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
	return parsed;
}

/** Region of a Bedrock runtime endpoint, falling back to the credential environment for SDK-default endpoints. */
export function bedrockRegion(model: Model<Api>, env: NodeJS.ProcessEnv): string | undefined {
	if (model.api !== "bedrock-converse-stream" && !isBedrockInferenceHost(model.baseUrl)) return undefined;
	if (model.baseUrl) {
		const hostname = new URL(model.baseUrl).hostname;
		const match = /^bedrock-runtime\.([a-z0-9-]+)\./.exec(hostname);
		if (match) return match[1];
	}
	return env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined;
}

/** Only Kimi K3.1 is gated initially; other providers/models retain their existing behavior and still get telemetry. */
export function throughputPolicy(
	model: Model<Api>,
	env: NodeJS.ProcessEnv = process.env,
): ThroughputPolicy | undefined {
	const outputBurndown = bedrockOutputBurndown(model);
	if (outputBurndown === 1 || (model.api !== "bedrock-converse-stream" && !isBedrockInferenceHost(model.baseUrl)))
		return undefined;
	const region = bedrockRegion(model, env);
	return {
		key: `${model.provider}/${model.id}@${region ?? "default"}`,
		region,
		tokensPerMinute: positiveLimit(
			"OCTOCODE_BEDROCK_KIMI_TPM",
			env.OCTOCODE_BEDROCK_KIMI_TPM,
			DEFAULT_KIMI_TOKENS_PER_MINUTE,
		),
		requestsPerMinute: positiveLimit(
			"OCTOCODE_BEDROCK_KIMI_RPM",
			env.OCTOCODE_BEDROCK_KIMI_RPM,
			DEFAULT_KIMI_REQUESTS_PER_MINUTE,
		),
		outputBurndown,
	};
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Output limit on the final wire body across the OpenAI, AI-SDK and Converse payload spellings. */
export function payloadMaxTokens(payload: unknown): number | undefined {
	if (!isRecord(payload)) return undefined;
	for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens", "maxOutputTokens", "maxTokens"]) {
		const found = positiveNumber(payload[key]);
		if (found !== undefined) return found;
	}
	return isRecord(payload.inferenceConfig) ? positiveNumber(payload.inferenceConfig.maxTokens) : undefined;
}

/** Estimate uncached input from the normalized transcript; the last receipt's cache reads do not consume final TPM. */
export function estimatedUncachedInputTokens(context: TranscriptContext, model: Model<Api>): number {
	const estimate = estimateContextTokens(context, model);
	const index = estimate.lastUsageIndex;
	if (index === null) return estimate.tokens;
	const message = context.messages[index];
	const cacheRead = message?.role === "assistant" ? message.usage.cacheRead : 0;
	return Math.max(0, estimate.tokens - cacheRead);
}

export function requestPriority(
	requested: RequestPriority | undefined,
	env: NodeJS.ProcessEnv = process.env,
): RequestPriority {
	return requested ?? (envFlag(env, SUBAGENT_ENV) ? "subagent" : "foreground");
}

/** Foreground can use the whole adaptive window; lower priorities leave headroom even before a throttle. */
export function priorityUtilization(priority: RequestPriority): number {
	return { foreground: 1, subagent: 0.85, compaction: 0.7, background: 0.5 }[priority];
}

/** Lower-priority work is shed until enough sustained foreground success restores its recovery threshold. */
export function shedsAtScale(priority: RequestPriority, scale: number): boolean {
	if (priority === "foreground") return false;
	const minimum = { subagent: 0.25, compaction: 0.8, background: 1 }[priority];
	return scale + Number.EPSILON < minimum;
}
