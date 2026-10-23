import { afterEach, describe, expect, it } from "vitest";
import { describeTabs, selectTab } from "../../src/octocode/browser/tabs.ts";
import { type CdpStub, startCdpStub } from "./fixtures/cdp-stub.ts";

let cdp: CdpStub | undefined;
afterEach(async () => {
	await cdp?.close();
	cdp = undefined;
});

describe("tabs listing", () => {
	it("lists every title and URL whole, however long", async () => {
		const title = `Report ${"t".repeat(300)}`;
		const url = `https://example.test/path?q=${"u".repeat(500)}`;
		cdp = await startCdpStub({
			targets: [
				{ id: "page-1", type: "page", url, title },
				{ id: "page-2", type: "page", url: "https://example.test/" },
			],
		});
		const text = await describeTabs({ port: cdp.port, targetId: "page-1" } as never);
		expect(text.split("\n")).toEqual([
			"Tabs (2; * = driven):",
			"  [1] (untitled) — https://example.test/",
			`* [2] ${title} — ${url}`,
			"tab with index switches to one; tab with url opens a new one.",
		]);
	});
	it("keeps tab numbers after another tab closes and never reuses its number", async () => {
		cdp = await startCdpStub({
			targets: [
				{ id: "C", type: "page", title: "C" },
				{ id: "B", type: "page", title: "B" },
				{ id: "A", type: "page", title: "A" },
			],
		});
		const session = { port: cdp.port, targetId: "C", page: { evaluate: async () => "complete" } } as never;
		expect(await describeTabs(session)).toContain("[2] B");
		await fetch(`http://127.0.0.1:${cdp.port}/json/close/A`);
		const after = await describeTabs(session);
		expect(after).toContain("[2] B");
		expect(after).toContain("[3] C");
		await expect(selectTab(session, 1, async () => () => undefined)).rejects.toThrow("No tab 1");
		await expect(selectTab(session, 3, async () => () => undefined)).resolves.toBeUndefined();
		cdp.addTarget("D");
		expect(await describeTabs(session)).toContain("[4]");
	});
});
