import { describe, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { totals } from "../../src/octocode/sessions/session-scan.ts";
import { SpendScan } from "../../src/octocode/shared/spend.ts";
import { memoizedModelLookup, type ModelLookup, unpricedModel } from "../../src/octocode/shared/util.ts";
import { registerFooter } from "../../src/octocode/ui/footer.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";

const paid = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const reply = (provider = "p", model = "a", timestamp = Date.parse("2026-01-02T00:00:00Z")) => ({
	role: "assistant",
	provider,
	model,
	timestamp,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
});
const entries = Array.from({ length: 10_000 }, (_, i) => ({
	type: "message",
	message: i % 3 === 0 ? reply("q", "a") : reply("p", i % 3 === 1 ? "a" : "b"),
}));

describe("history model lookup lifetime", () => {
	it("looks up each provider/model once in a 10k-entry totals pass and refreshes the next pass", () => {
		let cost = paid;
		const find = vi.fn<ModelLookup>(() => ({ cost }));
		const first = totals(entries, null, find, new SpendScan());
		expect(find).toHaveBeenCalledTimes(3);
		expect(first).toMatchObject({ unpriced: false, usage: { input: 10_000, output: 10_000 } });
		cost = free;
		expect(totals(entries, null, find, new SpendScan()).unpriced).toBe(true);
		// Once an unpriced reply is found the existing totals fold need not inspect more model prices.
		expect(find).toHaveBeenCalledTimes(4);
	});

	it("caches missing registry results and keeps distinct provider/id pairs separate", () => {
		const find = vi.fn<ModelLookup>(() => undefined);
		const cached = memoizedModelLookup(find);
		expect(cached("p/a", "b")).toBeUndefined();
		expect(cached("p/a", "b")).toBeUndefined();
		expect(cached("p", "a/b")).toBeUndefined();
		expect(find).toHaveBeenCalledTimes(2);
	});

	it("still resolves expiring rates at each reply timestamp within one cached lookup", () => {
		const find = vi.fn<ModelLookup>(() => ({ cost: { ...free, until: "2026-01-01", after: paid } }));
		const cached = memoizedModelLookup(find);
		const before = reply("p", "a", Date.parse("2026-01-01T12:00:00Z"));
		const after = reply("p", "a", Date.parse("2026-01-02T00:00:00Z"));
		expect(unpricedModel(after, cached)).toBeUndefined();
		expect(unpricedModel(before, cached)).toBe("p/a");
		expect(find).toHaveBeenCalledTimes(1);
		expect(
			totals(
				[
					{ type: "message", message: after },
					{ type: "message", message: before },
				],
				null,
				find,
				new SpendScan(),
			).unpriced,
		).toBe(true);
	});

	it("memoizes the footer's 10k-entry restore only, then sees catalog changes on live events and another restore", async () => {
		const fake = fakeHost();
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd: "/work/app" });
		let cost = paid;
		const find = vi.fn(() => ({ cost }) as never);
		ctx.modelRegistry.find = find;
		ctx.sessionManager.getEntries = () => entries as never;
		await fake.emit("session_start", {}, ctx);
		expect(find).toHaveBeenCalledTimes(3);
		const factory = ctx.ui.footer as NonNullable<Parameters<FeatureContext["ui"]["setFooter"]>[0]>;
		const component = factory({ requestRender: vi.fn() } as never, theme, {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
		} as never);
		try {
			cost = free;
			await fake.emit("message_end", { message: reply() }, ctx);
			expect(find).toHaveBeenCalledTimes(5);
			expect(component.render(160).join("\n")).toContain("n/a");
			cost = paid;
			await fake.emit("session_start", {}, ctx);
			expect(find).toHaveBeenCalledTimes(8);
			expect(component.render(160).join("\n")).not.toContain("n/a");
		} finally {
			component.dispose?.();
		}
	});
});
