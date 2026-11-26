import {
	type Api,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { createPendingAssistantMessage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configuredRequestsPerMinute,
	REQUEST_RATE_WINDOW_MS,
	requestRateStep,
	RequestRateWindows,
	type RequestRateWait,
} from "../src/core/model-runtime/request-rate.ts";
import { type ModelRequestHost, streamSimpleChatModel } from "../src/core/model-runtime/requests.ts";
import type { ModelsJsonProvider } from "../src/core/model-config.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});

afterEach(() => {
	vi.useRealTimers();
});

const model = (provider: string, id = "m") => ({ provider, id }) as unknown as Model<Api>;

/** Settles pending timers and promises up to `ms` of fake time. */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("the request-rate window", () => {
	it("lets the limit pass at once and holds the next send until the oldest leaves the window", async () => {
		const windows = new RequestRateWindows();
		const start = Date.now();
		for (let i = 0; i < 12; i++) await windows.admit("p", 12);
		expect(Date.now()).toBe(start);
		let admitted = false;
		const waits: (RequestRateWait | undefined)[] = [];
		const thirteenth = windows.admit("p", 12, { onCooldownWait: (wait) => waits.push(wait) }).then((waited) => {
			admitted = true;
			return waited;
		});
		await advance(REQUEST_RATE_WINDOW_MS - 1);
		expect(admitted).toBe(false);
		await advance(1);
		expect(await thirteenth).toBe(REQUEST_RATE_WINDOW_MS);
		expect(Date.now()).toBe(start + REQUEST_RATE_WINDOW_MS);
		expect(waits).toEqual([{ provider: "p", until: start + REQUEST_RATE_WINDOW_MS }, undefined]);
	});

	it("is off for a limit of 0", async () => {
		const windows = new RequestRateWindows();
		for (let i = 0; i < 100; i++) expect(await windows.admit("p", 0)).toBe(0);
	});

	it("does not share a window between providers", async () => {
		const windows = new RequestRateWindows();
		for (let i = 0; i < 2; i++) await windows.admit("a", 2);
		expect(await windows.admit("b", 2)).toBe(0);
	});

	it("gives each session its own window for a provider", async () => {
		const windows = new RequestRateWindows();
		for (let i = 0; i < 2; i++) await windows.admit("a", 2, { sessionId: "one" });
		expect(await windows.admit("a", 2, { sessionId: "two" })).toBe(0);
		let third = false;
		const held = windows.admit("a", 2, { sessionId: "one" }).then(() => (third = true));
		await vi.advanceTimersByTimeAsync(REQUEST_RATE_WINDOW_MS - 1);
		expect(third).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await held;
	});

	it("sheds a background refresh instead of waiting, and keeps the last slot for the user's request", async () => {
		const windows = new RequestRateWindows();
		const background = { requestPriority: "background" as const };
		expect(await windows.admit("a", 3, background)).toBe(0);
		expect(await windows.admit("a", 3, background)).toBe(0);
		await expect(windows.admit("a", 3, background)).rejects.toMatchObject({ name: "ThroughputShedError" });
		expect(await windows.admit("a", 3)).toBe(0);
	});

	it("forgets windows whose sends all left, once many are kept", async () => {
		const windows = new RequestRateWindows();
		for (let i = 0; i < 70; i++) await windows.admit("a", 1, { sessionId: `s${i}` });
		await vi.advanceTimersByTimeAsync(REQUEST_RATE_WINDOW_MS);
		await windows.admit("a", 1, { sessionId: "s0" });
		expect(await windows.admit("a", 1, { sessionId: "s1" })).toBe(0);
		expect((windows as unknown as { sends: Map<string, number[]> }).sends.size).toBe(2);
	});

	it("ends a wait with the abort error and leaves no slot taken", async () => {
		const windows = new RequestRateWindows();
		await windows.admit("p", 1);
		const controller = new AbortController();
		const waits: (RequestRateWait | undefined)[] = [];
		const held = windows.admit("p", 1, { signal: controller.signal, onCooldownWait: (wait) => waits.push(wait) });
		const outcome = expect(held).rejects.toMatchObject({ name: "AbortError" });
		await advance(1_000);
		controller.abort();
		await outcome;
		expect(waits.at(-1)).toBeUndefined();
		// The aborted request took no slot: the next one waits only for the first send.
		const next = windows.admit("p", 1);
		await advance(REQUEST_RATE_WINDOW_MS - 1_000);
		expect(await next).toBe(REQUEST_RATE_WINDOW_MS - 1_000);
	});

	it("waits for enough sends to leave when the limit was lowered", async () => {
		const windows = new RequestRateWindows();
		for (let i = 0; i < 3; i++) {
			await windows.admit("p", 3);
			await advance(1_000);
		}
		const start = Date.now();
		const next = windows.admit("p", 1);
		// Sends at t-3s, t-2s and t-1s: it needs the newest of them to leave.
		await advance(REQUEST_RATE_WINDOW_MS - 1_001);
		let done = false;
		void next.then(() => (done = true));
		await advance(0);
		expect(done).toBe(false);
		await advance(1);
		await next;
		expect(Date.now()).toBe(start + REQUEST_RATE_WINDOW_MS - 1_000);
	});
});

describe("the limit a model gets", () => {
	const provider: ModelsJsonProvider = {
		requestsPerMinute: 5,
		models: [{ id: "own", requestsPerMinute: 2 }],
		modelOverrides: { builtin: { requestsPerMinute: 3 } },
	};

	it("takes the model's value over the provider's, and the provider's when the model sets none", () => {
		expect(configuredRequestsPerMinute(provider, "own")).toBe(2);
		expect(configuredRequestsPerMinute(provider, "builtin")).toBe(3);
		expect(configuredRequestsPerMinute(provider, "other")).toBe(5);
	});

	it("has none when models.json sets none, so the setting decides", () => {
		expect(configuredRequestsPerMinute(undefined, "x")).toBeUndefined();
		expect(configuredRequestsPerMinute({ models: [{ id: "x" }] }, "x")).toBeUndefined();
		// A model's 0 turns the limit off even under a provider limit.
		expect(
			configuredRequestsPerMinute({ requestsPerMinute: 5, models: [{ id: "x", requestsPerMinute: 0 }] }, "x"),
		).toBe(0);
	});
});

describe("the physical request path", () => {
	function setup(
		limitOf: (model: Model<Api>) => number | undefined,
		retriesPerRequest = 0,
		payloadEachAttempt = false,
	) {
		const sent: string[] = [];
		const provider = {
			streamSimple: (requestModel: Model<Api>, _context: unknown, options: SimpleStreamOptions) => {
				const stream = createAssistantMessageEventStream();
				const message = createPendingAssistantMessage(requestModel);
				message.stopReason = "stop";
				queueMicrotask(async () => {
					try {
						await options.onPayload?.({}, requestModel);
						sent.push(requestModel.provider);
						for (let i = 0; i < retriesPerRequest; i++) {
							await options.onTransportRetry?.();
							if (payloadEachAttempt) await options.onPayload?.({}, requestModel);
							sent.push(requestModel.provider);
						}
						stream.push({ type: "done", reason: "stop", message });
						stream.end(message);
					} catch (error) {
						// A real provider turns an aborted hook into an aborted result.
						const aborted = { ...message, stopReason: "aborted" as const, errorMessage: String(error) };
						stream.push({ type: "error", reason: "aborted", error: aborted });
						stream.end(aborted);
					}
				});
				return stream;
			},
		} as unknown as Provider;
		const host: ModelRequestHost = {
			getProvider: () => provider,
			getAuth: async () => ({ auth: { apiKey: "key" } }),
			getCachePolicy: () => ({ options: {} }) as ReturnType<ModelRequestHost["getCachePolicy"]>,
			requestsPerMinute: limitOf,
			resolveModel: async () => {
				throw new Error("not routed");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		};
		const send = (providerId: string, options?: Parameters<typeof streamSimpleChatModel>[3]) =>
			streamSimpleChatModel(
				host,
				{
					...getBuiltinModel("amazon-bedrock", "global.zai.glm-5.3"),
					provider: providerId,
					id: "m",
					api: "openai-completions",
					baseUrl: "https://example.invalid/v1",
				},
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				options,
			).result();
		return { send, sent };
	}

	it("passes 12 requests, holds the 13th for the window and adds the wait to the trace", async () => {
		const { send, sent } = setup(() => 12);
		const provider = `rate-path-${process.pid}-a`;
		const start = Date.now();
		for (let i = 0; i < 12; i++) await send(provider);
		expect(sent).toHaveLength(12);
		const waits: (RequestRateWait | undefined)[] = [];
		const thirteenth = send(provider, { onCooldownWait: (wait) => waits.push(wait) });
		await advance(REQUEST_RATE_WINDOW_MS - 1);
		expect(sent).toHaveLength(12);
		await advance(1);
		const result = await thirteenth;
		expect(sent).toHaveLength(13);
		expect(Date.now()).toBe(start + REQUEST_RATE_WINDOW_MS);
		expect(result.requestTrace?.throughput?.gateWaitMs).toBe(REQUEST_RATE_WINDOW_MS);
		expect(waits).toEqual([{ provider, until: start + REQUEST_RATE_WINDOW_MS }, undefined]);
	});

	it("counts transport retries as sends", async () => {
		const { send, sent } = setup(() => 4, 1);
		const provider = `rate-path-${process.pid}-b`;
		await send(provider);
		await send(provider);
		expect(sent).toHaveLength(4);
		const third = send(provider);
		await advance(0);
		expect(sent).toHaveLength(4);
		await advance(REQUEST_RATE_WINDOW_MS);
		await third;
		expect(sent).toHaveLength(6);
	});

	it("counts a retry once when the transport builds the payload again for it", async () => {
		const { send, sent } = setup(() => 4, 1, true);
		const provider = `rate-path-${process.pid}-c`;
		await send(provider);
		await send(provider);
		expect(sent).toHaveLength(4);
		const third = send(provider);
		await advance(0);
		expect(sent).toHaveLength(4);
		await advance(REQUEST_RATE_WINDOW_MS);
		await third;
		expect(sent).toHaveLength(6);
	});

	it("does not limit with 0 or with no limit known, and keeps providers apart", async () => {
		const off = setup(() => 0);
		for (let i = 0; i < 30; i++) await off.send(`rate-path-${process.pid}-c`);
		expect(off.sent).toHaveLength(30);
		const none = setup(() => undefined);
		for (let i = 0; i < 30; i++) await none.send(`rate-path-${process.pid}-d`);
		expect(none.sent).toHaveLength(30);
		const two = setup(() => 1);
		await two.send(`rate-path-${process.pid}-e`);
		await two.send(`rate-path-${process.pid}-f`);
		expect(two.sent).toHaveLength(2);
	});

	it("rejects a request aborted while it waits", async () => {
		const { send, sent } = setup(() => 1);
		const provider = `rate-path-${process.pid}-g`;
		await send(provider);
		const controller = new AbortController();
		const held = send(provider, { signal: controller.signal });
		await advance(1_000);
		controller.abort();
		const result = await held;
		expect(result.stopReason).toBe("aborted");
		expect(sent).toHaveLength(1);
	});
});

describe("the step", () => {
	it("takes a slot for each wrapped send, so a rerun with a renewed key counts", async () => {
		const windows = new RequestRateWindows();
		const step = requestRateStep(model("renew"), undefined, 1, windows);
		const send = () => step.wrap<SimpleStreamOptions>({}).onPayload?.({}, model("renew"));
		await send();
		let second = false;
		const rerun = Promise.resolve(send()).then(() => (second = true));
		await advance(REQUEST_RATE_WINDOW_MS - 1);
		expect(second).toBe(false);
		await advance(1);
		await rerun;
		expect(second).toBe(true);
	});

	it("leaves hooks that were not set to the upstream", async () => {
		const step = requestRateStep(model("p"), undefined, 0, new RequestRateWindows());
		const onResponse = vi.fn();
		const hooks = step.wrap({ onResponse } as never) as { onResponse: unknown };
		expect(hooks.onResponse).toBe(onResponse);
	});
});
