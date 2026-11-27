/**
 * The cool-down step of one chat request (`requests.ts`): it waits out what is left of its provider's cool-down
 * (`provider-cooldown.ts`) before it goes out, and records one when it ends in a rate limit. It waits only for the remaining
 * time plus per-request jitter, so callers on the same credential can resume at different times.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	DEFAULT_MAX_RETRY_DELAY_MS,
	type LazyStreamObserver,
	type Model,
	type ProviderRequestOptions,
} from "@octocodeai/octocode-ai";
import { createPendingAssistantMessage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { isBedrockInferenceHost } from "@octocodeai/octocode-ai/utils/provider-host";
import { formatDuration } from "../../utils/duration.ts";
import { type CooldownRefusal, coolsDown, type ProviderCooldowns, providerCooldowns } from "./provider-cooldown.ts";

/** A request waiting out its provider's cool-down: until when (ms since the epoch). */
interface CooldownWait {
	provider: string;
	until: number;
}

export interface CooldownRequestOptions extends Pick<ProviderRequestOptions, "onRateLimit" | "onTransportRetry"> {
	signal?: AbortSignal;
	/** The request's limit on a wait the server asked for (default 60 s; 0: none): a longer cool-down fails it unsent. */
	maxRetryDelayMs?: number;
	/** Hears when the request starts waiting out a cool-down, and `undefined` once that wait is over. */
	onCooldownWait?: (wait: CooldownWait | undefined) => void;
}

function refusalMessage(refusal: CooldownRefusal): string {
	return `Rate limited: ${refusal.provider} is cooling down from a rate limit for ${formatDuration(refusal.remainingMs)} more, longer than this request waits (${formatDuration(refusal.maxWaitMs)}, retry.provider.maxRetryDelayMs). The request was not sent.`;
}

/** The failure of a request that was not sent: what is left of the cool-down travels as its `retryAfterMs`. */
function refusedStream(model: Model<Api>, refusal: CooldownRefusal): AssistantMessageEventStream {
	const error: AssistantMessage = {
		...createPendingAssistantMessage(model),
		stopReason: "error",
		errorMessage: refusalMessage(refusal),
		retryAfterMs: refusal.remainingMs,
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error });
	stream.end(error);
	return stream;
}

/**
 * The step for one request to `model`'s provider. `ready` waits (abortable through the request's signal) and resolves
 * to undefined when the request may go out, or to a stream that already failed, unsent, when the wait is longer than
 * the request accepts. `observer` records a cool-down when a request that went out ends in a rate limit; a request
 * that never went out records nothing, so a refusal never extends the cool-down it reports.
 */
export function cooldownStep(
	model: Model<Api>,
	options: CooldownRequestOptions | undefined,
	cooldowns: ProviderCooldowns = providerCooldowns,
): {
	ready(requestModel?: Model<Api>): Promise<AssistantMessageEventStream | undefined>;
	hooks: Pick<ProviderRequestOptions, "onRateLimit" | "onTransportRetry">;
	observer: LazyStreamObserver;
} {
	const { provider } = model;
	let sentAt: number | undefined;
	let sentModel = model;
	const onCooldownWait = options?.onCooldownWait;
	const wait = () =>
		cooldowns.wait(provider, {
			signal: options?.signal,
			maxWaitMs: options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
			onWait: onCooldownWait && ((until) => onCooldownWait(until === undefined ? undefined : { provider, until })),
		});
	const record = (retryAfterMs?: number) => {
		if (sentAt === undefined) return;
		const bedrock = sentModel.api === "bedrock-converse-stream" || isBedrockInferenceHost(sentModel.baseUrl);
		cooldowns.record(provider, { startedAt: sentAt, retryAfterMs, maxBackoffMs: bedrock ? 60_000 : undefined });
		sentAt = undefined;
	};
	return {
		async ready(requestModel = model) {
			const refusal = await wait();
			if (refusal) return refusedStream(model, refusal);
			sentModel = requestModel;
			sentAt = Date.now();
			return undefined;
		},
		hooks: {
			async onRateLimit(delay) {
				record(delay);
				await options?.onRateLimit?.(delay);
			},
			async onTransportRetry() {
				sentAt = undefined;
				await options?.onTransportRetry?.();
				const refusal = await wait();
				if (refusal) {
					throw Object.assign(new Error(refusalMessage(refusal)), {
						status: 429,
						headers: new Headers({ "retry-after-ms": String(refusal.remainingMs) }),
					});
				}
				sentAt = Date.now();
			},
		},
		observer: {
			onEvent: (event) => {
				if (event.type === "error" && coolsDown(event.error.errorMessage)) record(event.error.retryAfterMs);
			},
		},
	};
}
