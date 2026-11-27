import { describe, expect, it, vi } from "vitest";
import { STATES, type Snapshot, type SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { BacklogProjection } from "../../src/octocode/workspace/backlog-projection.ts";

const item = (ref: string, overrides: Partial<SnapshotItem> = {}): SnapshotItem => ({
	ref,
	title: ref,
	goal: "Result",
	why: "Needed",
	body: "",
	paths: [],
	evidence: [],
	plan: "",
	state: "ongoing",
	priority: "p2",
	tags: [],
	createdBy: "s",
	createdAt: 0,
	updatedAt: 0,
	version: 1,
	derived: [],
	notes: [],
	...overrides,
});
const board = (items: SnapshotItem[]): Snapshot => ({
	repo: "repo",
	generatedAt: 0,
	states: STATES,
	idleMs: 10_000,
	items,
});

describe("cached backlog volatile projection", () => {
	it("refreshes a stopped holder without rereading the board and probes duplicate owners only once", () => {
		const initial = board([
			item("B1", { assignee: "s", assigneeLive: true }),
			item("B2", { assignee: "s", assigneeLive: true }),
		]);
		const load = vi.fn(() => initial);
		const lives = vi.fn(() => false);
		const projection = new BacklogProjection(load, lives);
		projection.read(0);
		expect(projection.refresh(1999)).toBeUndefined();
		const next = projection.refresh(2000)!;
		expect(next.items.map((entry) => entry.assigneeLive)).toEqual([false, false]);
		expect(next.items[0].version).toBe(1);
		expect(initial.items[0].assigneeLive).toBe(true);
		expect(lives).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledTimes(1);
		expect(projection.refresh(4000)).toBeUndefined();
		projection.clear();
		expect(projection.refresh(12_000)).toBeUndefined();
		expect(lives).toHaveBeenCalledTimes(2);
	});

	it("advances the board clock exactly when an open item becomes idle, excluding done work", () => {
		const projection = new BacklogProjection(
			() => board([item("B1"), item("B2", { state: "done", updatedAt: -5000 })]),
			() => false,
		);
		projection.read(0);
		expect(projection.refresh(10_000)).toBeUndefined();
		const next = projection.refresh(10_001)!;
		expect(next.generatedAt).toBe(10_001);
		expect(projection.refresh(20_000)).toBeUndefined();
	});

	it("keeps the writer's own holder live and replaces cached owners after a database change", () => {
		const load = vi.fn(() => board([item("B1", { assignee: "self", assigneeLive: true })]));
		const lives = vi.fn(() => false);
		const projection = new BacklogProjection(load, lives, "self");
		projection.read(0);
		expect(projection.refresh(2000)).toBeUndefined();
		expect(lives).not.toHaveBeenCalled();
		load.mockReturnValue(board([item("B1", { assignee: "new", assigneeLive: true })]));
		projection.read(3000);
		expect(projection.refresh(5000)?.items[0].assigneeLive).toBe(false);
		expect(lives).toHaveBeenCalledWith("new");
	});
});
