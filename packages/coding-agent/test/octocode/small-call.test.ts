import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { callSmallModel } from "../../src/octocode/subagents/small-call.ts";

const model = (id: string, input: number) => ({
	provider: "p",
	id,
	api: "faux",
	cost: { input, output: input, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	input: ["text"],
});
const parent = model("big", 15);
const cheap = model("cheap", 1);

const ctx = (available: unknown[], auth: { ok: boolean } = { ok: true }) =>
	({
		model: parent,
		modelRegistry: { getAvailable: () => available, getApiKeyAndHeaders: async () => ({ ...auth, apiKey: "k" }) },
	}) as unknown as FeatureContext;

const call = (
	context: FeatureContext,
	options: { fallbackToSession?: boolean } = {},
	reply = fauxAssistantMessage("ok"),
) => {
	const complete = vi.fn().mockResolvedValue(reply);
	return {
		complete,
		result: callSmallModel(context, {
			text: "hi",
			signal: new AbortController().signal,
			maxTokens: 64,
			complete,
			...options,
		}),
	};
};

describe("callSmallModel", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("calls the cheaper model the small purpose resolves to, with no cache", async () => {
		const { complete, result } = call(ctx([parent, cheap]));
		expect(await result).toEqual({
			text: "ok",
			model: "p/cheap",
			provider: "p",
			modelId: "cheap",
			usage: fauxAssistantMessage("ok").usage,
		});
		expect(complete.mock.calls[0][0].id).toBe("cheap");
		expect(complete.mock.calls[0][2]).toMatchObject({ maxTokens: 64, cacheRetention: "none" });
	});

	it("sends through the session's model runtime, which resolves the credential for each attempt", async () => {
		const streamSimple = vi.fn(() => ({ result: async () => fauxAssistantMessage("ok") }));
		const context = {
			model: parent,
			modelRegistry: {
				getAvailable: () => [parent, cheap],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
				streamSimple,
			},
		} as unknown as FeatureContext;
		const signal = new AbortController().signal;
		expect(await callSmallModel(context, { text: "hi", signal, maxTokens: 64 })).toMatchObject({ model: "p/cheap" });
		expect(streamSimple).toHaveBeenCalledTimes(1);
		const [target, , options] = streamSimple.mock.calls[0] as unknown as [{ id: string }, unknown, object];
		expect(target.id).toBe("cheap");
		expect(options).toEqual({ signal, maxTokens: 64, cacheRetention: "none" });
	});

	it("retries a rate limit within the caller's budget, and not at all without one", async () => {
		vi.useFakeTimers();
		const limited = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" });
		const scripted = () => vi.fn().mockResolvedValueOnce(limited).mockResolvedValue(fauxAssistantMessage("ok"));
		const options = { text: "hi", signal: new AbortController().signal, maxTokens: 8 };
		const retried = scripted();
		const pending = callSmallModel(ctx([parent, cheap]), {
			...options,
			retry: { retries: 1, maxWaitMs: 5_000 },
			complete: retried,
		});
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({ text: "ok" });
		expect(retried).toHaveBeenCalledTimes(2);
		const once = scripted();
		expect(await callSmallModel(ctx([parent, cheap]), { ...options, complete: once })).toEqual({
			error: "429 Too Many Requests",
		});
		expect(once).toHaveBeenCalledTimes(1);
	});

	it("returns the reply's usage and cost so a caller can record the spend", async () => {
		const reply = fauxAssistantMessage("ok");
		reply.usage = {
			...reply.usage,
			input: 120,
			output: 30,
			totalTokens: 150,
			cost: { ...reply.usage.cost, total: 0.0042 },
		};
		const result = await call(ctx([parent, cheap]), {}, reply).result;
		expect("usage" in result && result.usage.cost.total).toBe(0.0042);
		expect("usage" in result && result.usage.input).toBe(120);
	});

	it("fails without a cheaper model unless the session's own is allowed", async () => {
		expect(await call(ctx([parent])).result).toEqual({ error: "no cheaper model is available" });
		const { complete, result } = call(ctx([parent]), { fallbackToSession: true });
		expect(await result).toMatchObject({ text: "ok", model: "p/big", provider: "p", modelId: "big" });
		expect(complete.mock.calls[0][0].id).toBe("big");
	});

	it("names the cause of a failed authentication, call or empty reply", async () => {
		expect(await call(ctx([parent, cheap], { ok: false })).result).toEqual({ error: "p/cheap is not authenticated" });
		const errored = fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
		expect(await call(ctx([parent, cheap]), {}, errored).result).toEqual({ error: "overloaded" });
		const aborted = fauxAssistantMessage("", { stopReason: "aborted" });
		expect(await call(ctx([parent, cheap]), {}, aborted).result).toEqual({ error: "the call was cancelled" });
		expect(await call(ctx([parent, cheap]), {}, fauxAssistantMessage("")).result).toEqual({
			error: "p/cheap returned an empty reply",
		});
	});

	it("never rejects", async () => {
		const complete = vi.fn().mockRejectedValue(new Error("network"));
		const result = await callSmallModel(ctx([parent, cheap]), {
			text: "hi",
			signal: new AbortController().signal,
			maxTokens: 8,
			complete,
		});
		expect(result).toEqual({ error: "network" });
		expect(
			await callSmallModel({ model: undefined } as unknown as FeatureContext, {
				text: "",
				signal: new AbortController().signal,
				maxTokens: 8,
			}),
		).toEqual({ error: "no model is selected" });
	});
});
