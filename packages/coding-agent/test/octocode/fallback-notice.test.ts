import { describe, expect, it, vi } from "vitest";
import { registerFallbackNotice } from "../../src/octocode/ui/footer/notices.ts";
import { asSetup } from "./fake-host.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function setup(planBilled: readonly string[] = []) {
	let handler: Handler | undefined;
	registerFallbackNotice(asSetup({ on: (_name: string, h: Handler) => void (handler = h) }) as never);
	const notify = vi.fn();
	const modelRegistry = {
		getProviderBilling: (provider: string) => (planBilled.includes(provider) ? "plan" : "metered"),
	};
	const ctx = { hasUI: true, ui: { notify }, modelRegistry };
	const model = { provider: "anthropic", id: "b" };
	return { notify, ctx, model, select: (event: object, c: unknown = ctx) => handler?.(event, c) };
}

describe("registerFallbackNotice", () => {
	it("shows one warning per fallback switch, and none for other sources or without a UI", async () => {
		const { notify, ctx, model, select } = setup();
		await select({ source: "fallback", model, previousModel: { provider: "openai", id: "a" } });
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toContain("openai/a hit a usage limit; continuing on anthropic/b");
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
		await select({ source: "set", model });
		await select({ source: "fallback", model }, { ...ctx, hasUI: false });
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("names the cause the switch carries: a refused credential is not a usage limit", async () => {
		const { notify, model, select } = setup();
		await select({
			source: "fallback",
			reason: "refused the credential",
			model,
			previousModel: { provider: "openai", id: "a" },
		});
		expect(notify.mock.calls[0]?.[0]).toContain("openai/a refused the credential; continuing on anthropic/b");
	});

	it("names a change between plan and per-token billing, as the run warning does", async () => {
		const { notify, model, select } = setup(["openai"]);
		await select({ source: "fallback", model, previousModel: { provider: "openai", id: "a" } });
		expect(notify.mock.calls[0]?.[0]).toBe(
			"openai/a hit a usage limit; continuing on anthropic/b, billed per token instead of by plan (retry.fallbackModels). /model switches back.",
		);
		const same = setup();
		await same.select({ source: "fallback", model, previousModel: { provider: "openai", id: "a" } });
		expect(same.notify.mock.calls[0]?.[0]).not.toContain("billed");
	});
});
