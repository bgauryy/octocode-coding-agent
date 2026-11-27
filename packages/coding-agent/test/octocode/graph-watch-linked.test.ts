import { describe, expect, it } from "vitest";
import { linkedWhileWorking } from "../../src/octocode/subagents/graph-watch.ts";

/**
 * Decision 2 (the graph never stalls): an item counts as linked to a child only while that child can still file the report
 * that carries the graph line. A child that ended and left its item open keeps an entry in the run map, and treating that
 * entry as linked would silence the outside-completion wake forever.
 */
describe("graph watch: linked only while the child works", () => {
	const items = new Map([
		["kid-running", "B1"],
		["kid-ended", "B2"],
		["kid-background", "B3"],
	]);
	const working = new Set(["kid-running", "kid-background"]);
	const linked = (ref: string) => linkedWhileWorking(items, (id) => working.has(id), ref);

	it("is linked while a running or background child works on the item", () => {
		expect(linked("B1")).toBe(true);
		expect(linked("B3")).toBe(true);
	});

	it("is not linked once the item's child ended, so an outside completion wakes the coordinator", () => {
		expect(linked("B2")).toBe(false);
	});

	it("is not linked for an item no child was started on", () => {
		expect(linked("B9")).toBe(false);
	});
});
