/** Payload-time token/RPM admission and response reconciliation for physical chat requests. */

import { randomUUID } from "node:crypto";
import {
	type AgentDb,
	providerThroughput as providerThroughputQueries,
	type ThroughputReserveInput,
	type ThroughputReserveResult,
	type ThroughputState,
} from "../../../../db/src/api.ts";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	DEFAULT_MAX_RETRY_DELAY_MS,
	type LazyStreamObserver,
	type Model,
	type ProviderRequestOptions,
	type ProviderResponse,
	type RequestPriority,
	type RequestThroughput,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { createAbortError, sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";
import { bedrockQuotaTokens, estimateBedrockAdmissionTokens } from "@octocodeai/octocode-ai/utils/bedrock-throughput";
import { sharedAgentDb } from "../../storage/database.ts";
import type { CooldownRequestOptions } from "./cooldown-request.ts";
import { coolsDown } from "./provider-cooldown.ts";
import {
	admissionClass,
	bedrockRegion,
	estimatedUncachedInputTokens,
	payloadMaxTokens,
	priorityUtilization,
	requestPriority,
	shedsAtScale,
	THROUGHPUT_WINDOW_MS,
	throughputPolicy,
} from "./throughput-policy.ts";

export interface ThroughputStore {
	reserve(input: ThroughputReserveInput): ThroughputReserveResult;
	reconcile(input: { key: string; windowStart: number; reservationId: string; actualTokens: number }): boolean;
	release(input: { key: string; windowStart: number; reservationId: string }): boolean;
	recordThrottle(key: string, now: number): ThroughputState;
	recordFailure(key: string, now: number): ThroughputState;
	recordSuccess(key: string, now: number): ThroughputState;
	state(key: string): ThroughputState;
}

/** Synchronous shared reservations: unlike derived cool-down writes, admission cannot use the asynchronous DB writer. */
function agentDbThroughputStore(env: NodeJS.ProcessEnv = process.env): ThroughputStore {
	let agent: AgentDb | undefined;
	const db = () => {
		if (!agent?.db.isOpen) agent = sharedAgentDb(env);
		return agent.db;
	};
	return {
		reserve: (input) => providerThroughputQueries.reserve(db(), input),
		reconcile: (input) => providerThroughputQueries.reconcile(db(), input),
		release: (input) => providerThroughputQueries.release(db(), input),
		recordThrottle: (key, now) => providerThroughputQueries.recordThrottle(db(), key, now),
		recordFailure: (key, now) => providerThroughputQueries.recordFailure(db(), key, now),
		recordSuccess: (key, now) => providerThroughputQueries.recordSuccess(db(), key, now),
		state: (key) => providerThroughputQueries.state(db(), key),
	};
}

export class ProviderThroughput {
	private store: ThroughputStore | undefined;
	private readonly openStore: () => ThroughputStore;
	readonly now: () => number;
	readonly reservationId: () => string;

	constructor(
		openStore: () => ThroughputStore,
		now: () => number = () => Date.now(),
		reservationId: () => string = () => randomUUID(),
	) {
		this.openStore = openStore;
		this.now = now;
		this.reservationId = reservationId;
	}

	private shared<T>(use: (store: ThroughputStore) => T): T {
		this.store ??= this.openStore();
		return use(this.store);
	}

	state(key: string): ThroughputState {
		return this.shared((store) => store.state(key));
	}

	reserve(input: ThroughputReserveInput): ThroughputReserveResult {
		return this.shared((store) => store.reserve(input));
	}

	reconcile(input: { key: string; windowStart: number; reservationId: string; actualTokens: number }): void {
		this.shared((store) => store.reconcile(input));
	}

	release(input: { key: string; windowStart: number; reservationId: string }): void {
		this.shared((store) => store.release(input));
	}

	throttle(key: string): void {
		this.shared((store) => store.recordThrottle(key, this.now()));
	}

	fail(key: string): void {
		this.shared((store) => store.recordFailure(key, this.now()));
	}

	succeed(key: string): void {
		this.shared((store) => store.recordSuccess(key, this.now()));
	}
}

const providerThroughput = new ProviderThroughput(() => agentDbThroughputStore());

export interface ThroughputRequestOptions extends CooldownRequestOptions {
	maxTokens?: number;
	requestPriority?: RequestPriority;
}

type Hooks = Pick<ProviderRequestOptions, "onPayload" | "onResponse" | "onTransportRetry" | "onRateLimit">;
interface Reservation {
	key: string;
	windowStart: number;
	reservationId: string;
}

export class ThroughputShedError extends Error {
	override readonly name = "ThroughputShedError";
}

function messageOf(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return undefined;
}

function attach(message: AssistantMessage, throughput: RequestThroughput): void {
	message.requestTrace = { layers: [], ...message.requestTrace, throughput };
}

function requestId(response: ProviderResponse): string | undefined {
	return (
		response.headers["x-amzn-requestid"] ?? response.headers["x-amz-request-id"] ?? response.headers["x-request-id"]
	);
}

/** One request's hooks and observer. The trace object is shared so actual fields remain visible after layer chaining. */
export function throughputStep(
	model: Model<Api>,
	context: TranscriptContext,
	options: ThroughputRequestOptions | undefined,
	throughput: ProviderThroughput = providerThroughput,
): { hooks(upstream: Hooks, requestModel: Model<Api>, env: NodeJS.ProcessEnv): Hooks; observer: LazyStreamObserver } {
	const priority = requestPriority(options?.requestPriority);
	// The label stays the caller's; admission and shedding follow the agent a compaction summarizes for.
	const admission = admissionClass(priority);
	const metrics: RequestThroughput = {
		model: model.id,
		priority,
		gateWaitMs: 0,
		estimatedInputTokens: 0,
		estimatedAdmissionTokens: 0,
	};
	let reservation: Reservation | undefined;
	let sentModel = model;
	let responseSeen = false;
	let throttled = false;
	let responseStatus: number | undefined;
	let settled = false;

	// A transport retry or a provider fallback starts a new physical request. A rejected request still
	// spent one RPM. Without response headers its token use is unknown, so keep its estimate until expiry.
	const endPreviousAttempt = () => {
		if (reservation) {
			if (responseStatus !== undefined && responseStatus >= 400)
				throughput.reconcile({ ...reservation, actualTokens: 0 });
			if (!throttled) throughput.fail(reservation.key);
			reservation = undefined;
		}
		responseStatus = undefined;
		responseSeen = false;
		throttled = false;
	};

	const settle = (message: AssistantMessage | undefined) => {
		if (!message || settled) return;
		settled = true;
		attach(message, metrics);
		const usage = message.usage;
		metrics.actualInputTokens = usage.input;
		metrics.actualOutputTokens = usage.output;
		metrics.actualCacheReadTokens = usage.cacheRead;
		metrics.actualCacheWriteTokens = usage.cacheWrite;
		metrics.actualTokens = bedrockQuotaTokens(sentModel, usage);
		if (!reservation) return;
		const unused = Object.values(usage).every((value) => typeof value !== "number" || value === 0);
		if (message.stopReason === "aborted" && !responseSeen && unused) throughput.release(reservation);
		else throughput.reconcile({ ...reservation, actualTokens: metrics.actualTokens });
		if (throttled) return;
		if (message.stopReason === "error" && coolsDown(message.errorMessage)) throughput.throttle(reservation.key);
		else if (message.stopReason === "error") throughput.fail(reservation.key);
		else if (message.stopReason !== "aborted") throughput.succeed(reservation.key);
	};

	return {
		hooks(upstream, requestModel, env) {
			metrics.model = requestModel.id;
			metrics.region = throughputPolicy(requestModel, env)?.region ?? bedrockRegion(requestModel, env);
			const admit = async () => {
				const policy = throughputPolicy(sentModel, env);
				if (!policy || metrics.maxTokens === undefined) return;
				metrics.region = policy.region;
				// The local cap counts final tokens per minute, so an in-flight request holds its worst-case final charge
				// (output at the burndown rate); `estimatedAdmissionTokens` stays AWS's 1x admission charge, and
				// reconciliation lowers the hold to the actual final charge.
				metrics.reservedTokens = metrics.estimatedInputTokens + metrics.maxTokens * policy.outputBurndown;
				const waitStarted = throughput.now();
				let waiting = false;
				try {
					for (;;) {
						options?.signal?.throwIfAborted();
						const now = throughput.now();
						const windowStart = Math.floor(now / THROUGHPUT_WINDOW_MS) * THROUGHPUT_WINDOW_MS;
						const state = throughput.state(policy.key);
						metrics.adaptiveScale = state.scale;
						if (shedsAtScale(admission, state.scale)) {
							metrics.shed = true;
							throw new ThroughputShedError(
								`${priority} request shed for ${sentModel.id}: shared capacity is ${Math.round(state.scale * 100)}%.`,
							);
						}
						const candidate = {
							key: policy.key,
							windowStart,
							reservationId: throughput.reservationId(),
						};
						const admitted = throughput.reserve({
							...candidate,
							now,
							estimatedTokens: metrics.reservedTokens,
							tokenLimit: policy.tokensPerMinute,
							requestLimit: policy.requestsPerMinute,
							utilization: priorityUtilization(admission),
						});
						if (admitted.admitted) {
							reservation = candidate;
							return;
						}
						if (admission === "background") {
							metrics.shed = true;
							throw new ThroughputShedError(
								`${priority} request shed for ${sentModel.id}: its capacity headroom is full.`,
							);
						}
						const remainingMs = Math.max(0, admitted.retryAt - now);
						const maxWaitMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
						if (maxWaitMs > 0 && admitted.retryAt - waitStarted > maxWaitMs)
							throw new Error(
								`Provider throughput window for ${sentModel.id} would require ${admitted.retryAt - waitStarted}ms total wait (limit ${maxWaitMs}ms). The request was not sent.`,
							);
						waiting = true;
						options?.onCooldownWait?.({ provider: sentModel.provider, until: admitted.retryAt });
						await sleepUnlessAborted(remainingMs, options?.signal, createAbortError);
					}
				} finally {
					metrics.gateWaitMs += Math.max(0, throughput.now() - waitStarted);
					if (waiting) options?.onCooldownWait?.(undefined);
				}
			};
			return {
				onPayload: async (payload, payloadModel) => {
					endPreviousAttempt();
					const replaced = await upstream.onPayload?.(payload, payloadModel);
					sentModel = payloadModel;
					const finalPayload = replaced ?? payload;
					const maxTokens = payloadMaxTokens(finalPayload) ?? options?.maxTokens ?? payloadModel.maxTokens;
					const estimatedInput = estimatedUncachedInputTokens(context, payloadModel);
					metrics.model = payloadModel.id;
					metrics.maxTokens = maxTokens;
					metrics.estimatedInputTokens = estimatedInput;
					metrics.estimatedAdmissionTokens = estimateBedrockAdmissionTokens(estimatedInput, maxTokens);
					await admit();
					return replaced;
				},
				onRateLimit: async (delay) => {
					if (reservation && !throttled) {
						throughput.throttle(reservation.key);
						throttled = true;
					}
					await upstream.onRateLimit?.(delay);
				},
				onTransportRetry: async () => {
					endPreviousAttempt();
					await upstream.onTransportRetry?.();
					await admit();
				},
				onResponse: async (response, responseModel) => {
					responseSeen = true;
					responseStatus = response.status;

					metrics.requestId = requestId(response);
					await upstream.onResponse?.(response, responseModel);
				},
			};
		},
		observer: {
			onEvent: (event) => settle(messageOf(event)),
			onResult: (result) => settle(result),
		},
	};
}
