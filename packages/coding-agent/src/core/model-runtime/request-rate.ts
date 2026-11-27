/**
 * The request-rate step of one chat request (`requests.ts`): a sliding window per session and provider that holds a
 * physical request until fewer than `requestsPerMinute` went out in the last minute. Every send counts: the first
 * attempt, each transport retry, a rerun with a renewed key, compaction summaries and cache-warming refreshes. A
 * background refresh never waits and never takes the last slot: it is shed instead, so it cannot delay the user's next
 * request or land after the entry it refreshes expired. The windows live in memory, so a subagent (its own process)
 * has its own; the shared throughput gate (`throughput-request.ts`) is separate and both apply.
 */

import type { Api, LazyStreamObserver, Model, ProviderRequestOptions, RequestPriority } from "@octocodeai/octocode-ai";
import { createAbortError, sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";
import type { ModelsJsonProvider } from "../model-config.ts";
import { ThroughputShedError } from "./throughput-request.ts";

export const REQUEST_RATE_WINDOW_MS = 60_000;

/** A request waiting for a slot in its provider's window: whose, and until when (ms since the epoch). */
export interface RequestRateWait {
	provider: string;
	until: number;
}

export interface RequestRateOptions {
	signal?: AbortSignal;
	/** The session whose window counts the send; without one, the process's window for the provider. */
	sessionId?: string;
	/** `background` (cache warming) is shed rather than delayed. */
	requestPriority?: RequestPriority;
	/** Hears when the request starts waiting for a slot, and `undefined` once that wait is over. */
	onCooldownWait?: (wait: RequestRateWait | undefined) => void;
}

/** Windows kept before idle ones are swept: one per session and provider in use. */
const SWEEP_ABOVE = 64;

/** The send times of the last window, per session and provider. Each list holds at most the provider's limit. */
export class RequestRateWindows {
	private readonly sends = new Map<string, number[]>();
	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** Takes a slot for `provider`, waiting while the window is full. Returns the ms waited. Rejects with the abort error. */
	async admit(provider: string, limit: number, options: RequestRateOptions = {}): Promise<number> {
		if (limit <= 0) return 0;
		const key = options.sessionId === undefined ? provider : `${options.sessionId}\0${provider}`;
		const background = options.requestPriority === "background";
		const started = this.now();
		let waiting = false;
		try {
			for (;;) {
				options.signal?.throwIfAborted();
				const now = this.now();
				if (this.sends.size > SWEEP_ABOVE) this.sweep(now);
				const sends = this.sends.get(key) ?? [];
				while (sends.length > 0 && sends[0] <= now - REQUEST_RATE_WINDOW_MS) sends.shift();
				if (sends.length < (background && limit > 1 ? limit - 1 : limit)) {
					sends.push(now);
					this.sends.set(key, sends);
					return Math.max(0, now - started);
				}
				if (background) {
					throw new ThroughputShedError(
						`background request shed for ${provider}: ${limit} requests per minute leave no slot to spare.`,
					);
				}
				// A lowered limit leaves more sends in the window than it allows: wait until enough of them have left.
				const until = sends[sends.length - limit] + REQUEST_RATE_WINDOW_MS;
				waiting = true;
				options.onCooldownWait?.({ provider, until });
				await sleepUnlessAborted(Math.max(0, until - now), options.signal, createAbortError);
			}
		} finally {
			if (waiting) options.onCooldownWait?.(undefined);
		}
	}

	/** Drops windows whose last send left the window: sessions that ended or went quiet. */
	private sweep(now: number): void {
		for (const [key, sends] of this.sends) {
			if ((sends.at(-1) ?? 0) <= now - REQUEST_RATE_WINDOW_MS) this.sends.delete(key);
		}
	}
}

const requestRateWindows = new RequestRateWindows();

/** A models.json limit for the model: its own entry or override, else its provider's. Undefined: none configured. */
export function configuredRequestsPerMinute(
	provider: ModelsJsonProvider | undefined,
	modelId: string,
): number | undefined {
	if (!provider) return undefined;
	return (
		provider.models?.find((model) => model.id === modelId)?.requestsPerMinute ??
		provider.modelOverrides?.[modelId]?.requestsPerMinute ??
		provider.requestsPerMinute
	);
}

/** A models.json token budget for the model: its own entry or override, else its provider's. Undefined: none configured. */
export function configuredTokensPerMinute(
	provider: ModelsJsonProvider | undefined,
	modelId: string,
): number | undefined {
	if (!provider) return undefined;
	return (
		provider.models?.find((model) => model.id === modelId)?.tokensPerMinute ??
		provider.modelOverrides?.[modelId]?.tokensPerMinute ??
		provider.tokensPerMinute
	);
}

type Hooks = Pick<ProviderRequestOptions, "onPayload" | "onTransportRetry">;

/**
 * The step for one request to `model`'s provider. `wrap` puts a slot in front of the hooks that start each physical
 * send; `observer` adds the time waited to the request trace's `throughput.gateWaitMs`, once the throughput step has
 * attached it. `limit` 0, or undefined, turns the window off.
 */
export function requestRateStep(
	model: Model<Api>,
	options: RequestRateOptions | undefined,
	limit: number | undefined,
	windows: RequestRateWindows = requestRateWindows,
): { wrap<T extends Hooks>(upstream: T): T; observer: LazyStreamObserver } {
	let waitedMs = 0;
	let reported = false;
	const admit = async () => {
		waitedMs += await windows.admit(model.provider, limit ?? 0, options);
	};
	const report = (message: { requestTrace?: { throughput?: { gateWaitMs: number } } } | undefined) => {
		if (reported || !message?.requestTrace?.throughput) return;
		reported = true;
		message.requestTrace.throughput.gateWaitMs += waitedMs;
	};
	return {
		// One wrap per send of the request: the first, and a rerun with a renewed key. AI SDK transports call `onPayload`
		// again on each transport retry, after `onTransportRetry` took that attempt's slot.
		wrap: (upstream) => {
			let firstPayload = true;
			return {
				...upstream,
				onPayload: async (payload, payloadModel) => {
					if (firstPayload) {
						firstPayload = false;
						await admit();
					}
					return upstream.onPayload?.(payload, payloadModel);
				},
				onTransportRetry: async () => {
					await admit();
					await upstream.onTransportRetry?.();
				},
			};
		},
		observer: {
			onEvent: (event) => {
				if (event.type === "done") report(event.message);
				else if (event.type === "error") report(event.error);
			},
			onResult: report,
		},
	};
}
