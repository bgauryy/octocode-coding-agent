import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { rewritePrompt } from "../../src/octocode/prompt-optimization/rewrite.ts";

const session = {
	provider: "p",
	id: "big",
	api: "faux",
	cost: { input: 15, output: 15, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	input: ["text"],
};
const ctx = {
	model: session,
	modelRegistry: { getAvailable: () => [session], getApiKeyAndHeaders: async () => ({ ok: true }) },
} as unknown as FeatureContext;
const limited = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" });

describe("prompt optimization's model call", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a rate limit briefly while the user waits, then names the failure that remains", async () => {
		vi.useFakeTimers();
		const signal = new AbortController().signal;
		const recovering = vi
			.fn()
			.mockResolvedValueOnce(limited())
			.mockResolvedValue(fauxAssistantMessage("<request>Fix the login redirect loop</request>"));
		const pending = rewritePrompt(ctx, "fix login", signal, recovering);
		await vi.runAllTimersAsync();
		expect(await pending).toEqual({ text: "Fix the login redirect loop", model: "p/big" });
		expect(recovering).toHaveBeenCalledTimes(2);

		const throttled = vi.fn().mockImplementation(async () => limited());
		const failing = rewritePrompt(ctx, "fix login", signal, throttled);
		await vi.runAllTimersAsync();
		expect(await failing).toEqual({ error: "429 Too Many Requests" });
		// The first call and at most a few seconds of retries: the helper's own 30 s limit is never the one that ends it.
		expect(throttled.mock.calls.length).toBeGreaterThan(1);
		expect(throttled.mock.calls.length).toBeLessThanOrEqual(3);
	});
});
