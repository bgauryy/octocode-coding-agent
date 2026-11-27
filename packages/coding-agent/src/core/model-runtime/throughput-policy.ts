/**
 * Capacity and request-priority policy for the shared throughput gate: a conservative Bedrock/Kimi default, and a
 * token budget for any model whose models.json sets `tokensPerMinute`.
 */

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
	/** Absent: no request cap in the gate (a configured token budget alone). */
	requestsPerMinute?: number;
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

/**
 * The shared gate's policy for a model, or undefined when it is not gated. Two kinds are: Bedrock models whose output
 * tokens burn down faster than they count (Kimi K3.1), with built-in limits and environment overrides, and any model
 * with a models.json `tokensPerMinute`, which gets a token budget only (the session request window owns requests per
 * minute, `request-rate.ts`).
 */
export function throughputPolicy(
	model: Model<Api>,
	env: NodeJS.ProcessEnv = process.env,
	configuredTokensPerMinute?: number,
): ThroughputPolicy | undefined {
	const outputBurndown = bedrockOutputBurndown(model);
	const bedrock = model.api === "bedrock-converse-stream" || isBedrockInferenceHost(model.baseUrl);
	if (bedrock && outputBurndown !== 1) {
		const region = bedrockRegion(model, env);
		return {
			key: `${model.provider}/${model.id}@${region ?? "default"}`,
			region,
			// The environment variable overrides the models.json budget, which overrides the built-in default.
			tokensPerMinute: positiveLimit(
				"OCTOCODE_BEDROCK_KIMI_TPM",
				env.OCTOCODE_BEDROCK_KIMI_TPM,
				configuredTokensPerMinute ?? DEFAULT_KIMI_TOKENS_PER_MINUTE,
			),
			requestsPerMinute: positiveLimit(
				"OCTOCODE_BEDROCK_KIMI_RPM",
				env.OCTOCODE_BEDROCK_KIMI_RPM,
				DEFAULT_KIMI_REQUESTS_PER_MINUTE,
			),
			outputBurndown,
		};
	}
	if (configuredTokensPerMinute === undefined) return undefined;
	const region = bedrock ? bedrockRegion(model, env) : undefined;
	return {
		key: bedrock ? `${model.provider}/${model.id}@${region ?? "default"}` : `${model.provider}/${model.id}`,
		region,
		tokensPerMinute: configuredTokensPerMinute,
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
	return requested ?? agentPriority(env);
}

/** The priority of this process's own turns: a subagent's, or the main session's. */
function agentPriority(env: NodeJS.ProcessEnv): "foreground" | "subagent" {
	return envFlag(env, SUBAGENT_ENV) ? "subagent" : "foreground";
}

export type AdmissionClass = Exclude<RequestPriority, "compaction">;

/**
 * The class a request is admitted as. A compaction summary is admitted as the agent it summarizes for: that agent waits
 * for it, and when it is refused Octocode's default summary goes out at once at the agent's own priority, uncached, so
 * holding it back frees no capacity. Speculative summaries (the early summary) are sent as `background`.
 */
export function admissionClass(priority: RequestPriority, env: NodeJS.ProcessEnv = process.env): AdmissionClass {
	return priority === "compaction" ? agentPriority(env) : priority;
}

/** Foreground can use the whole adaptive window; lower priorities leave headroom even before a throttle. */
export function priorityUtilization(admission: AdmissionClass): number {
	return { foreground: 1, subagent: 0.85, background: 0.5 }[admission];
}

/** Lower-priority work is shed until enough sustained foreground success restores its recovery threshold. */
export function shedsAtScale(admission: AdmissionClass, scale: number): boolean {
	if (admission === "foreground") return false;
	const minimum = { subagent: 0.25, background: 1 }[admission];
	return scale + Number.EPSILON < minimum;
}
