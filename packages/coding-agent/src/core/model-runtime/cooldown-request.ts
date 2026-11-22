/**
 * The cool-down step of one chat request (`requests.ts`): it waits out what is left of its provider's cool-down
 * (`provider-cooldown.ts`) before it goes out, and records one when it ends in a rate limit. Only what is left is
 * waited, so the wait never stacks on the session retry's own sleep for the same failure.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	DEFAULT_MAX_RETRY_DELAY_MS,
	type LazyStreamObserver,
	type Model,
} from "@octocodeai/octocode-ai";
import { createPendingAssistantMessage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { formatDuration } from "../../utils/duration.ts";
import { type CooldownRefusal, coolsDown, type ProviderCooldowns, providerCooldowns } from "./provider-cooldown.ts";

/** A request waiting out its provider's cool-down: until when (ms since the epoch). */
interface CooldownWait {
	provider: string;
	until: number;
}

export interface CooldownRequestOptions {
	signal?: AbortSignal;
	/** The request's limit on a wait the server asked for (default 60 s; 0: none): a longer cool-down fails it unsent. */
	maxRetryDelayMs?: number;
	/** Hears when the request starts waiting out a cool-down, and `undefined` once that wait is over. */
	onCooldownWait?: (wait: CooldownWait | undefined) => void;
}

/** The failure of a request that was not sent: what is left of the cool-down travels as its `retryAfterMs`. */
function refusedStream(model: Model<Api>, refusal: CooldownRefusal): AssistantMessageEventStream {
	const error: AssistantMessage = {
		...createPendingAssistantMessage(model),
		stopReason: "error",
		errorMessage: `Rate limited: ${refusal.provider} is cooling down from a rate limit for ${formatDuration(refusal.remainingMs)} more, longer than this request waits (${formatDuration(refusal.maxWaitMs)}, retry.provider.maxRetryDelayMs). The request was not sent.`,
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
): { ready(): Promise<AssistantMessageEventStream | undefined>; observer: LazyStreamObserver } {
	const { provider } = model;
	let sentAt: number | undefined;
	const onCooldownWait = options?.onCooldownWait;
	return {
		async ready() {
			const refusal = await cooldowns.wait(provider, {
				signal: options?.signal,
				maxWaitMs: options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
				onWait: onCooldownWait && ((until) => onCooldownWait(until === undefined ? undefined : { provider, until })),
			});
			if (refusal) return refusedStream(model, refusal);
			sentAt = Date.now();
			return undefined;
		},
		// On the error event itself, which reaches this observer before the caller can act on it (a retry, a sibling's start).
		observer: {
			onEvent: (event) => {
				if (sentAt === undefined || event.type !== "error" || !coolsDown(event.error.errorMessage)) return;
				cooldowns.record(provider, { startedAt: sentAt, retryAfterMs: event.error.retryAfterMs });
			},
		},
	};
}
