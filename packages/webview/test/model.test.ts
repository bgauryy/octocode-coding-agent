import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { describe, expect, it } from "vitest";
import {
	attention,
	backlogStats,
	blocks,
	buildTree,
	filterBoard,
	filterTable,
	indexBacklog,
	originChain,
} from "../src/app/model/backlog.ts";
import { editorDefaults, toMutation } from "../src/app/model/editor.ts";
import { ago, span, stamp } from "../src/app/model/format.ts";
import { readLaunch } from "../src/access.ts";
import { hashFor, parseHash, resolveRoute } from "../src/app/model/route.ts";
import { snapshotItem } from "./helpers.ts";

const DAY = 86_400_000;
function snapshot(items: SnapshotItem[], generatedAt = 10 * DAY): Snapshot {
	return { repo: "repo", generatedAt, states: ["backlog", "todo", "ongoing", "done"], idleMs: 7 * DAY, items };
}

describe("format", () => {
	it("formats durations compactly at each scale", () => {
		expect(span(-5)).toBe("0s");
		expect(span(59_000)).toBe("59s");
		expect(span(5 * 60_000)).toBe("5m");
		expect(span(90 * 60_000)).toBe("1h30m");
		expect(span(2 * 3_600_000)).toBe("2h");
		expect(span(DAY + 3_600_000)).toBe("1d1h");
		expect(ago(DAY, 0)).toBe("1d ago");
	});
	it("stamps local times as minutes", () => {
		expect(stamp(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
	});
});

describe("route", () => {
	it("round-trips view parameters and drops empty values", () => {
		const hash = hashFor("table", { q: "a b&c", state: "", sort: "ref" });
		expect(hash).toBe("#table?q=a%20b%26c&sort=ref");
		expect(parseHash(hash)).toEqual({ name: "table", params: { q: "a b&c", sort: "ref" } });
		expect(parseHash("#board?bad=%E0")).toEqual({ name: "board", params: { bad: "%E0" } });
	});
	it("resolves items, editor routes and unknown views", () => {
		const views = ["board", "table"];
		expect(resolveRoute(parseHash("#b12"), views)).toEqual({ kind: "item", ref: "B12", mode: "view" });
		expect(resolveRoute(parseHash("#B3/edit"), views)).toEqual({ kind: "item", ref: "B3", mode: "edit" });
		expect(resolveRoute(parseHash("#B3/correct"), views)).toEqual({ kind: "item", ref: "B3", mode: "correct" });
		expect(resolveRoute(parseHash("#new"), views)).toEqual({ kind: "new" });
		expect(resolveRoute(parseHash("#table?q=x"), views)).toEqual({ kind: "view", view: "table", params: { q: "x" } });
		expect(resolveRoute(parseHash("#agents"), views)).toEqual({ kind: "view", view: "board", params: {} });
	});
	it("reads a launch fragment once and never keeps the token in the hash", () => {
		expect(readLaunch("#access=secret&view=activity")).toEqual({ access: "secret", hash: "#activity" });
		expect(readLaunch("#access=secret&view=unknown")).toEqual({ access: "secret", hash: "#board" });
		expect(readLaunch("#board")).toBeNull();
	});
});

describe("backlog", () => {
	const items = [
		snapshotItem("B1", {
			state: "ongoing",
			priority: "p0",
			assignee: "ghost",
			assigneeLive: false,
			tags: ["ui"],
			updatedAt: 0,
		}),
		snapshotItem("B2", {
			state: "todo",
			blockedBy: ["B1"],
			dependsOn: [{ resource: "backlogs", repositoryKey: "r", id: "B1" }],
		}),
		snapshotItem("B3", {
			state: "todo",
			type: "bug",
			goal: "Resolve the issue",
			why: "Unblock users",
			notes: [{ at: 0, author: "kim", kind: "note", text: "needle in a note" }],
		}),
		snapshotItem("B4", {
			state: "done",
			startedAt: DAY,
			doneAt: 3 * DAY,
			updatedAt: 9 * DAY,
			parentId: "B5",
			from: "B5",
		}),
		snapshotItem("B5", { state: "backlog", children: ["B4"], derived: ["B4"], updatedAt: 9 * DAY, from: "B6" }),
		snapshotItem("B6", { derived: ["B5"], updatedAt: 9 * DAY }),
	];
	const index = indexBacklog(snapshot(items));

	it("filters the board by search, priority, type and readiness", () => {
		expect(filterBoard(index, { q: "NEEDLE" }).map((it) => it.ref)).toEqual(["B3"]);
		expect(filterBoard(index, { p: "p0" }).map((it) => it.ref)).toEqual(["B1"]);
		expect(filterBoard(index, { type: "bug" }).map((it) => it.ref)).toEqual(["B3"]);
		expect(filterBoard(index, { ready: "ready" }).map((it) => it.ref)).toEqual(["B3"]);
	});
	it("sorts the table with stable reference tie-breaking", () => {
		expect(filterTable(index, { sort: "priority", dir: "asc" }).map((it) => it.ref)).toEqual([
			"B1",
			"B2",
			"B3",
			"B4",
			"B5",
			"B6",
		]);
		expect(filterTable(index, { sort: "updated", dir: "desc", state: "todo" }).map((it) => it.ref)).toEqual([
			"B2",
			"B3",
		]);
		expect(filterTable(index, { tag: "ui" }).map((it) => it.ref)).toEqual(["B1"]);
		expect(filterTable(index, { sort: "nonsense" }).map((it) => it.ref)[0]).toBe("B4");
	});
	it("builds a cycle-safe derivation tree", () => {
		const cyclic = indexBacklog(
			snapshot([snapshotItem("B1", { children: ["B2"] }), snapshotItem("B2", { parentId: "B1", children: ["B1"] })]),
		);
		const tree = buildTree(cyclic);
		expect(tree.roots.map((node) => node.item.ref)).toEqual(["B1"]);
		expect(tree.roots[0].children[0].children).toEqual([]);
		expect(buildTree(index).alone.map((it) => it.ref)).toEqual(["B1", "B2", "B3", "B6"]);
	});
	it("surfaces stale claims and idle work, oldest first", () => {
		const result = attention(index);
		expect(result.claims.map((it) => it.ref)).toEqual(["B1"]);
		expect(result.idle.map((it) => it.ref)).toEqual(["B1", "B2", "B3"]);
	});
	it("derives relationships and summary statistics", () => {
		expect(originChain(index, index.byRef.get("B4")!)).toEqual(["B6", "B5"]);
		expect(blocks(index, "B1")).toEqual(["B2"]);
		const stats = backlogStats(index);
		expect(stats.byState).toEqual({ backlog: 2, todo: 2, ongoing: 1, done: 1 });
		expect(stats.medianCycle).toBe(2 * DAY);
		expect(stats.attention).toBe(3);
	});
});

describe("editor", () => {
	const done = snapshotItem("B9", {
		state: "done",
		version: 4,
		links: [
			{ relation: "evidence", target: { resource: "files", repositoryKey: "r", path: "a.ts" } },
			{ relation: "related", target: { resource: "external", url: "https://keep.example" } },
		],
		completions: [
			{
				id: 7,
				actor: "a",
				at: 0,
				version: 3,
				goal: "",
				operationKey: "k",
				summary: "Shipped",
				files: [{ path: "src/a.ts", role: "reviewed" }],
				verification: { status: "passed", summary: "tests" },
			},
		],
	});

	it("creates a new item with parsed lists and no completion", () => {
		const values = {
			...editorDefaults(),
			title: " Write docs ",
			tags: "docs, ux  web",
			dependsOn: "B1 B2",
			paths: "a\n\nb",
			urls: "https://x.test\n",
		};
		const mutation = toMutation(values, { operationKey: "op", states: ["backlog", "todo", "ongoing", "done"] });
		expect(mutation).toMatchObject({
			op: "add",
			title: "Write docs",
			type: "feature",
			state: "backlog",
			priority: 2,
			tags: ["docs", "ux", "web"],
			dependsOn: ["B1", "B2"],
			paths: ["a", "b"],
			parentId: null,
			links: [{ relation: "related", target: { resource: "external", url: "https://x.test" } }],
		});
		expect(mutation).not.toHaveProperty("completion");
		expect(mutation).not.toHaveProperty("note");
	});
	it("records a completion when an item moves to done", () => {
		const values = {
			...editorDefaults(snapshotItem("B2", { state: "todo" })),
			state: "done",
			summary: "Done",
			files: "x.ts\n",
		};
		const mutation = toMutation(values, {
			item: snapshotItem("B2", { state: "todo", version: 2 }),
			baseVersion: 2,
			operationKey: "op",
			states: ["backlog", "todo", "ongoing", "done"],
		});
		expect(mutation).toMatchObject({ op: "update", id: "B2", version: 2 });
		expect(mutation.completion).toMatchObject({
			summary: "Done",
			files: [{ path: "x.ts", role: "changed" }],
			verification: { status: "not_run" },
			operationKey: "op",
		});
	});
	it("corrects a prior result, keeping file roles and non-external links", () => {
		const values = { ...editorDefaults(done, true), summary: "Shipped v2", files: "src/a.ts\nsrc/b.ts" };
		expect(values.state).toBe("done");
		const mutation = toMutation(values, {
			item: done,
			correction: true,
			baseVersion: 4,
			operationKey: "op",
			states: ["backlog", "todo", "ongoing", "done"],
		});
		expect(mutation).not.toHaveProperty("goal");
		expect(mutation.completion).toMatchObject({
			replaces: 7,
			files: [
				{ path: "src/a.ts", role: "reviewed" },
				{ path: "src/b.ts", role: "changed" },
			],
		});
		expect(mutation.links).toEqual(done.links);
	});
	it("rejects values outside the allowed choices", () => {
		expect(() =>
			toMutation({ ...editorDefaults(), title: "x", type: "story" }, { operationKey: "op", states: ["backlog"] }),
		).toThrow("Invalid choice");
	});
});
