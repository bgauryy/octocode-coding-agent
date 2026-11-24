import {
	type Api,
	type AssistantMessage,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
	normalizeContext,
} from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { createPendingAssistantMessage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThroughputReserveInput, ThroughputReserveResult, ThroughputState } from "../../db/src/api.ts";
import {
	ProviderThroughput,
	ThroughputShedError,
	throughputStep,
	type ThroughputStore,
} from "../src/core/model-runtime/throughput-request.ts";
import { type ModelRequestHost, streamSimpleChatModel } from "../src/core/model-runtime/requests.ts";

const kimi = getBuiltinModel("amazon-bedrock", "global.moonshotai.kimi-k3.1");
const glm = getBuiltinModel("amazon-bedrock", "global.zai.glm-5.3");
const env = { AWS_REGION: "eu-central-1" };

interface Row extends ReservationId {
	estimated: number;
	actual?: number;
}
interface ReservationId {
	key: string;
	windowStart: number;
	reservationId: string;
}

class MemoryStore implements ThroughputStore {
	readonly rows = new Map<string, Row>();
	readonly scales = new Map<string, ThroughputState>();

	private usage(input: ThroughputReserveInput) {
		let tokens = 0;
		let requests = 0;
		for (const row of this.rows.values())
			if (row.key === input.key && row.windowStart === input.windowStart) {
				tokens += row.actual ?? row.estimated;
				requests++;
			}
		return { tokens, requests };
	}

	reserve(input: ThroughputReserveInput): ThroughputReserveResult {
		const scale = this.state(input.key).scale * (input.utilization ?? 1);
		const effectiveTokenLimit = Math.max(1, Math.floor(input.tokenLimit * scale));
		const effectiveRequestLimit = Math.max(1, Math.floor(input.requestLimit * scale));
		const usage = this.usage(input);
		const id = `${input.key}/${input.windowStart}/${input.reservationId}`;
		const held = this.rows.has(id);
		const fits =
			usage.tokens + input.estimatedTokens <= effectiveTokenLimit && usage.requests + 1 <= effectiveRequestLimit;
		if (!held && !fits && usage.requests > 0)
			return {
				admitted: false,
				effectiveTokenLimit,
				effectiveRequestLimit,
				usage,
				retryAt: input.windowStart + 60_000,
			};
		if (!held) this.rows.set(id, { ...input, estimated: input.estimatedTokens });
		return {
			admitted: true,
			effectiveTokenLimit,
			effectiveRequestLimit,
			usage: held ? usage : { tokens: usage.tokens + input.estimatedTokens, requests: usage.requests + 1 },
		};
	}

	reconcile(input: ReservationId & { actualTokens: number }): boolean {
		const row = this.rows.get(`${input.key}/${input.windowStart}/${input.reservationId}`);
		if (!row) return false;
		row.actual = input.actualTokens;
		return true;
	}

	release(input: ReservationId): boolean {
		return this.rows.delete(`${input.key}/${input.windowStart}/${input.reservationId}`);
	}

	recordThrottle(key: string, _now: number): ThroughputState {
		const next = { scale: Math.max(0.1, this.state(key).scale / 2), successes: 0 };
		this.scales.set(key, next);
		return next;
	}

	recordFailure(key: string, _now: number): ThroughputState {
		const next = { scale: this.state(key).scale, successes: 0 };
		this.scales.set(key, next);
		return next;
	}

	recordSuccess(key: string, _now: number): ThroughputState {
		const state = this.state(key);
		const successes = state.successes + 1;
		const next =
			successes === 5
				? { scale: Math.min(1, Math.round((state.scale + 0.1) * 1e6) / 1e6), successes: 0 }
				: { scale: state.scale, successes };
		this.scales.set(key, next);
		return next;
	}

	state(key: string): ThroughputState {
		return this.scales.get(key) ?? { scale: 1, successes: 0 };
	}
}

function setup(target: Model<Api> = kimi, priority?: "foreground" | "subagent" | "compaction" | "background") {
	const model = {
		...target,
		baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1",
	};
	const store = new MemoryStore();
	let sequence = 0;
	const gate = new ProviderThroughput(
		() => store,
		() => Date.now(),
		() => `reservation-${++sequence}`,
	);
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	const step = throughputStep(model, context, { maxTokens: 100, requestPriority: priority }, gate);
	const hooks = step.hooks({}, model, env);
	return { store, gate, step, hooks, model };
}

function reply(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	const message = createPendingAssistantMessage(model);
	message.stopReason = stopReason;
	message.usage = { ...message.usage, input: 100, output: 20, cacheRead: 50, cacheWrite: 5 };
	return message;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("request throughput telemetry and reconciliation", () => {
	it("holds the worst-case final charge, reconciles to burndown TPM and completes actual usage and response metadata", async () => {
		const { store, step, hooks, model } = setup();
		await hooks.onPayload?.({ max_tokens: 100 }, model);
		await hooks.onResponse?.({ status: 200, headers: { "x-amzn-requestid": "request-1" } }, model);
		const message = reply(model);
		step.observer.onEvent?.({ type: "done", reason: "stop", message });
		const trace = message.requestTrace?.throughput;
		expect(trace).toMatchObject({
			model: model.id,
			region: "eu-central-1",
			priority: "foreground",
			maxTokens: 100,
			estimatedAdmissionTokens: (trace?.estimatedInputTokens ?? 0) + 100,
			reservedTokens: (trace?.estimatedInputTokens ?? 0) + 100 * 10,
			actualInputTokens: 100,
			actualOutputTokens: 20,
			actualCacheReadTokens: 50,
			actualCacheWriteTokens: 5,
			actualTokens: 305,
			requestId: "request-1",
			adaptiveScale: 1,
		});
		expect(trace?.gateWaitMs).toBeGreaterThanOrEqual(0);
		expect([...store.rows.values()][0]).toMatchObject({ actual: 305 });
	});

	it("reports Kimi's 1x admission charge, holds output at 10x, then reconciles to the actual charge", async () => {
		const { store, step, hooks, model } = setup();
		await hooks.onPayload?.({ max_tokens: 8192 }, model);
		const row = [...store.rows.values()][0];
		const message = reply(model);
		step.observer.onEvent?.({ type: "done", reason: "stop", message });
		const trace = message.requestTrace?.throughput;
		expect(trace?.estimatedAdmissionTokens).toBe((trace?.estimatedInputTokens ?? 0) + 8192);
		expect(row?.estimated).toBe((trace?.estimatedInputTokens ?? 0) + 8192 * 10);
		expect(trace?.reservedTokens).toBe(row?.estimated);
		expect(trace?.actualTokens).toBe(100 + 5 + 20 * 10);
		expect(row?.actual).toBe(305);
	});

	it("instruments non-gated models without opening a reservation", async () => {
		const { store, step, hooks, model } = setup(glm);
		await hooks.onPayload?.({ max_output_tokens: 100 }, model);
		const message = reply(model);
		step.observer.onEvent?.({ type: "done", reason: "stop", message });
		expect(message.requestTrace?.throughput).toMatchObject({ maxTokens: 100, actualTokens: 125, gateWaitMs: 0 });
		expect(store.rows.size).toBe(0);
	});

	it("captures a 429 request id, halves capacity and keeps its RPM charge", async () => {
		const { store, step, hooks, model } = setup();
		await hooks.onPayload?.({ max_tokens: 100 }, model);
		await hooks.onResponse?.({ status: 429, headers: { "x-request-id": "throttled-1" } }, model);
		const error = reply(model, "error");
		error.usage = { ...error.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		error.errorMessage = "429 rate_limit_exceeded";
		step.observer.onEvent?.({ type: "error", reason: "error", error });
		expect(error.requestTrace?.throughput).toMatchObject({ requestId: "throttled-1", actualTokens: 0 });
		expect(store.state([...store.rows.values()][0].key).scale).toBe(0.5);
		expect([...store.rows.values()][0]).toMatchObject({ actual: 0 });
	});

	it.each(["foreground", "background"] as const)(
		"accounts for each physical %s attempt after a 429",
		async (priority) => {
			const { step, store, model } = setup({ ...kimi, api: "openai-completions" }, priority);
			const reservationsAtSend: number[] = [];
			const onPayload = vi.fn();
			const fetch: typeof globalThis.fetch = async () => {
				reservationsAtSend.push(store.rows.size);
				if (reservationsAtSend.length === 1)
					return new Response("busy", { status: 429, headers: { "retry-after-ms": "1", "x-request-id": "busy-1" } });
				return new Response(
					'data: {"id":"ok","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1,"total_tokens":8}}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			const result = await streamSimple(
				{ ...model, provider: "bedrock-test" },
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					...step.hooks({ onPayload }, model, env),
					apiKey: "test",
					fetch,
					maxRetries: 1,
					maxTokens: 100,
				},
			).result();
			step.observer.onResult?.(result);
			expect(onPayload).toHaveBeenCalledOnce();
			expect([...store.rows.values()][0].actual).toBe(0);
			if (priority === "background") {
				expect(reservationsAtSend).toEqual([1]);
				expect(result.requestTrace?.throughput).toMatchObject({ shed: true, requestId: "busy-1" });
			} else {
				expect(result.stopReason).toBe("stop");
				expect(reservationsAtSend).toEqual([1, 2]);
				expect([...store.rows.values()][1].actual).toBe(17);
			}
			expect(store.state([...store.rows.values()][0].key).scale).toBe(0.5);
		},
	);

	it("raises capacity by 0.1 after five successes", async () => {
		const first = setup();
		const key = `amazon-bedrock/${kimi.id}@eu-central-1`;
		first.store.recordThrottle(key, Date.now());
		for (let index = 0; index < 5; index++) {
			const current = index === 0 ? first : setup();
			current.store.scales.set(key, first.store.state(key));
			await current.hooks.onPayload?.({ max_tokens: 100 }, current.model);
			const message = reply(current.model);
			current.step.observer.onEvent?.({ type: "done", reason: "stop", message });
			first.store.scales.set(key, current.store.state(key));
		}
		expect(first.store.state(key)).toEqual({ scale: 0.6, successes: 0 });
	});
});

describe("the physical runtime path", () => {
	it("returns wire and usage telemetry on the assistant result", async () => {
		const model = {
			...glm,
			provider: `throughput-test-${process.pid}`,
			id: "test-model",
			api: "openai-completions" as const,
			baseUrl: "https://example.invalid/v1",
		};
		const provider = {
			streamSimple: (requestModel: Model<Api>, _context: unknown, options: SimpleStreamOptions) => {
				const stream = createAssistantMessageEventStream();
				const message = reply(requestModel);
				queueMicrotask(async () => {
					await options.onPayload?.({ max_output_tokens: 100 }, requestModel);
					await options.onResponse?.({ status: 200, headers: { "x-request-id": "runtime-request" } }, requestModel);
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				});
				return stream;
			},
		} as unknown as Provider;
		const host: ModelRequestHost = {
			getProvider: () => provider,
			getAuth: async () => ({ auth: { apiKey: "key" } }),
			getCachePolicy: () => ({ options: {} }) as ReturnType<ModelRequestHost["getCachePolicy"]>,
			resolveModel: async () => {
				throw new Error("not routed");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		};
		const result = await streamSimpleChatModel(
			host,
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ requestPriority: "background" },
		).result();
		expect(result.requestTrace?.throughput).toMatchObject({
			model: "test-model",
			priority: "background",
			maxTokens: 100,
			actualTokens: 125,
			requestId: "runtime-request",
		});
	});
});

describe("admission waiting and priority shedding", () => {
	it("waits until capacity returns and records the wait", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { store, step, hooks, model } = setup();
		const key = `amazon-bedrock/${kimi.id}@eu-central-1`;
		store.reserve({
			key,
			windowStart: 0,
			reservationId: "existing",
			now: 0,
			estimatedTokens: 499_999,
			tokenLimit: 500_000,
			requestLimit: 60,
		});
		const pending = hooks.onPayload?.({ max_tokens: 100 }, model);
		await vi.advanceTimersByTimeAsync(60_000);
		await pending;
		const message = reply(model);
		step.observer.onEvent?.({ type: "done", reason: "stop", message });
		expect(message.requestTrace?.throughput?.gateWaitMs).toBe(60_000);
	});

	it("holds parallel long-output Kimi requests at 10x so their final charge stays under the window cap", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const capped = { ...env, OCTOCODE_BEDROCK_KIMI_TPM: "200000" };
		const model = { ...kimi, baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1" };
		const store = new MemoryStore();
		let sequence = 0;
		const gate = new ProviderThroughput(
			() => store,
			() => Date.now(),
			() => `reservation-${++sequence}`,
		);
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		const start = () => throughputStep(model, context, { maxTokens: 10_000 }, gate).hooks({}, model, capped);
		await start().onPayload?.({ max_tokens: 10_000 }, model);
		let secondAdmitted = false;
		const second = Promise.resolve(start().onPayload?.({ max_tokens: 10_000 }, model)).then(() => {
			secondAdmitted = true;
		});
		await vi.advanceTimersByTimeAsync(59_000);
		const held = [...store.rows.values()].filter((row) => row.windowStart === 0);
		expect(secondAdmitted).toBe(false);
		expect(held).toHaveLength(1);
		expect(held.reduce((sum, row) => sum + row.estimated, 0)).toBeLessThanOrEqual(200_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await second;
		expect(secondAdmitted).toBe(true);
	});

	it("bounds total admission time when new contention extends a wait", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { store, hooks, model } = setup();
		const refusal = {
			admitted: false,
			effectiveRequestLimit: 1,
			effectiveTokenLimit: 100,
			usage: { requests: 1, tokens: 100 },
		} as const;
		const reserve = vi
			.spyOn(store, "reserve")
			.mockReturnValueOnce({ ...refusal, retryAt: 40_000 })
			.mockReturnValueOnce({ ...refusal, retryAt: 80_000 });
		const rejected = expect(hooks.onPayload?.({ max_tokens: 100 }, model)).rejects.toThrow("80000ms total wait");
		await vi.advanceTimersByTimeAsync(40_000);
		await rejected;
		expect(reserve).toHaveBeenCalledTimes(2);
		expect(store.rows.size).toBe(0);
	});

	it("keeps foreground eligible while shedding a subagent below 25% capacity", async () => {
		const key = `amazon-bedrock/${kimi.id}@eu-central-1`;
		const child = setup(kimi, "subagent");
		for (let index = 0; index < 3; index++) child.store.recordThrottle(key, Date.now());
		await expect(child.hooks.onPayload?.({ max_tokens: 100 }, child.model)).rejects.toBeInstanceOf(ThroughputShedError);
		expect(child.store.rows.size).toBe(0);
		const foreground = setup(kimi, "foreground");
		foreground.store.scales.set(key, { scale: 0.125, successes: 0 });
		await foreground.hooks.onPayload?.({ max_tokens: 100 }, foreground.model);
		expect(foreground.store.rows.size).toBe(1);
	});

	it("releases tokens and RPM when a request aborts before any response", async () => {
		const { store, step, hooks, model } = setup();
		await hooks.onPayload?.({ max_tokens: 100 }, model);
		const aborted = reply(model, "aborted");
		aborted.usage = { ...aborted.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		step.observer.onEvent?.({ type: "error", reason: "aborted", error: aborted });
		expect(store.rows.size).toBe(0);
	});

	it("sheds background work after throttling without sending it", async () => {
		const { store, step, hooks, model } = setup(kimi, "background");
		const key = `amazon-bedrock/${kimi.id}@eu-central-1`;
		store.recordThrottle(key, Date.now());
		await expect(hooks.onPayload?.({ max_tokens: 100 }, model)).rejects.toBeInstanceOf(ThroughputShedError);
		expect(store.rows.size).toBe(0);
		const error = reply(model, "error");
		step.observer.onEvent?.({ type: "error", reason: "error", error });
		expect(error.requestTrace?.throughput).toMatchObject({ priority: "background", shed: true, adaptiveScale: 0.5 });
	});

	// Shedding a compaction frees nothing: Octocode's default summary is sent next at the session's own priority.
	it("admits a foreground session's compaction at reduced capacity and in a nearly full window", async () => {
		const key = `amazon-bedrock/${kimi.id}@eu-central-1`;
		const throttled = setup(kimi, "compaction");
		throttled.store.scales.set(key, { scale: 0.44, successes: 0 });
		await throttled.hooks.onPayload?.({ max_tokens: 100 }, throttled.model);
		expect(throttled.store.rows.size).toBe(1);
		const message = reply(throttled.model);
		throttled.step.observer.onEvent?.({ type: "done", reason: "stop", message });
		expect(message.requestTrace?.throughput).toMatchObject({ priority: "compaction", adaptiveScale: 0.44 });
		expect(message.requestTrace?.throughput?.shed).toBeUndefined();

		const busy = setup(kimi, "compaction");
		busy.store.reserve({
			key,
			windowStart: Math.floor(Date.now() / 60_000) * 60_000,
			reservationId: "other-session",
			now: Date.now(),
			estimatedTokens: 400_000,
			tokenLimit: 500_000,
			requestLimit: 60,
		});
		await busy.hooks.onPayload?.({ max_tokens: 100 }, busy.model);
		expect(busy.store.rows.size).toBe(2);
	});

	it("sheds a subagent's compaction only where the subagent's own requests are shed", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const key = `amazon-bedrock/${kimi.id}@eu-central-1`;
		const recovering = setup(kimi, "compaction");
		recovering.store.scales.set(key, { scale: 0.44, successes: 0 });
		await recovering.hooks.onPayload?.({ max_tokens: 100 }, recovering.model);
		expect(recovering.store.rows.size).toBe(1);
		const collapsed = setup(kimi, "compaction");
		collapsed.store.scales.set(key, { scale: 0.125, successes: 0 });
		await expect(collapsed.hooks.onPayload?.({ max_tokens: 100 }, collapsed.model)).rejects.toBeInstanceOf(
			ThroughputShedError,
		);
		expect(collapsed.store.rows.size).toBe(0);
	});
});
