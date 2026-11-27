import { safeWebLink } from "../src/link.ts";
import { createWorkspaceStore, selectEvents } from "../src/state.ts";
import { describe, expect, it } from "vitest";

describe("workspace output contracts", () => {
	it("allows web citations without enabling executable or credential-bearing links", () => {
		expect(safeWebLink("https://example.com/docs?q=one#two")).toBe("https://example.com/docs?q=one#two");
		for (const url of [
			"javascript:alert(1)",
			"data:text/html,test",
			"file:///tmp/private",
			"//example.com",
			"https://user:secret@example.com",
			"/api/workspace",
			"#agents",
		])
			expect(safeWebLink(url)).toBeNull();
	});
	it("surfaces failed tools and blocked agents without confusing successful results", () => {
		const store = createWorkspaceStore();
		store.getState().accept({
			sessionId: "s",
			agents: [],
			traffic: [],
			receipts: [],
			events: [
				{ id: 1, at: 0, type: "tool.result", text: "failed", outcome: "failed" },
				{ id: 2, at: 0, type: "agent.result", text: "blocked", details: { status: "blocked" } },
				{ id: 3, at: 0, type: "agent.result", text: "done", details: { status: "done" } },
			],
		});
		store.getState().setFilter("attention");
		expect(selectEvents(store.getState()).map((event) => event.id)).toEqual([2, 1]);
	});
});
