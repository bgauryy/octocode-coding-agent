import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/features/index.ts";
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
	}) as unknown as ExtensionContext;

const call = (
	context: ExtensionContext,
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
	it("calls the cheaper model the small purpose resolves to, with no cache and the key", async () => {
		const { complete, result } = call(ctx([parent, cheap]));
		expect(await result).toEqual({ text: "ok", model: "p/cheap" });
		expect(complete.mock.calls[0][0].id).toBe("cheap");
		expect(complete.mock.calls[0][2]).toMatchObject({ maxTokens: 64, cacheRetention: "none", apiKey: "k" });
	});

	it("fails without a cheaper model unless the session's own is allowed", async () => {
		expect(await call(ctx([parent])).result).toEqual({ error: "no cheaper model is available" });
		const { complete, result } = call(ctx([parent]), { fallbackToSession: true });
		expect(await result).toEqual({ text: "ok", model: "p/big" });
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
			await callSmallModel({ model: undefined } as unknown as ExtensionContext, {
				text: "",
				signal: new AbortController().signal,
				maxTokens: 8,
			}),
		).toEqual({ error: "no model is selected" });
	});
});
