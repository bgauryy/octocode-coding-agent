import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
import { describe, expect, it } from "vitest";
import {
	cycleTime,
	distinct,
	filterBoard,
	filterTable,
	indexBacklog,
	isStale,
	originChain,
	TABLE_COLUMNS,
} from "../src/app/model/backlog.ts";
import { editorDefaults, locksIntent, needsCompletion, restoreDraft, toMutation } from "../src/app/model/editor.ts";
import { choice, errorMessage, median, plural, span } from "../src/app/model/format.ts";
import { hashFor, parseHash, readLaunch, resolveRoute } from "../src/app/model/route.ts";
import { snapshotItem } from "./helpers.ts";

const STATES = ["backlog", "todo", "ongoing", "done"] as const;
function snapshot(items: SnapshotItem[]): Snapshot {
	return { repo: "repo", generatedAt: 0, states: STATES, idleMs: 1, items };
}

describe("format helpers", () => {
	it("median sorts numerically, averages the middle pair for even counts and is undefined when empty", () => {
		expect(median([])).toBeUndefined();
		expect(median([10, 2, 3])).toBe(3);
		expect(median([10, 1, 2, 4])).toBe(3);
		const input = [3, 1, 2];
		median(input);
		expect(input).toEqual([3, 1, 2]);
	});

	it("plural uses the singular only for exactly one and accepts an irregular plural", () => {
		expect(plural(0, "line")).toBe("0 lines");
		expect(plural(1, "line")).toBe("1 line");
		expect(plural(2, "child", "children")).toBe("2 children");
	});

	it("errorMessage reads an Error's message and stringifies anything else", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(42)).toBe("42");
	});

	it("choice returns the matching option and throws naming an unknown value", () => {
		expect(choice("b", ["a", "b"] as const)).toBe("b");
		expect(() => choice("c", ["a", "b"] as const)).toThrow("Invalid choice: c");
	});

	it("span omits a zero remainder at hour and day scale and floors partial seconds", () => {
		expect(span(1999)).toBe("1s");
		expect(span(3 * 86_400_000)).toBe("3d");
		expect(span(86_400_000 + 30 * 60_000)).toBe("1d");
	});
});

describe("route helpers", () => {
	it("hashFor with no parameters, or only empty ones, has no query string", () => {
		expect(hashFor("board")).toBe("#board");
		expect(hashFor("board", { q: "" })).toBe("#board");
	});

	it("parseHash reads a key without '=' as empty, skips empty pairs and tolerates a missing '#'", () => {
		expect(parseHash("table?flag&&q=x")).toEqual({ name: "table", params: { flag: "", q: "x" } });
		expect(parseHash("")).toEqual({ name: "", params: {} });
		expect(parseHash("#a?x=1=2")).toEqual({ name: "a", params: { x: "1=2" } });
	});

	it("resolveRoute keeps only refs of the form B<number> with known modes; others fall back to the board", () => {
		const views = ["board"];
		expect(resolveRoute(parseHash("#B12/delete"), views)).toEqual({ kind: "view", view: "board", params: {} });
		expect(resolveRoute(parseHash("#Bx"), views)).toEqual({ kind: "view", view: "board", params: {} });
		expect(resolveRoute(parseHash("#"), views)).toEqual({ kind: "view", view: "board", params: {} });
		expect(resolveRoute(parseHash("#board?q=1"), views)).toEqual({ kind: "view", view: "board", params: { q: "1" } });
	});

	it("readLaunch yields an empty access when the token is missing and defaults the view to the board", () => {
		expect(readLaunch("#access=")).toEqual({ access: "", hash: "#board" });
		expect(readLaunch("#access=a%20b")).toEqual({ access: "a b", hash: "#board" });
		expect(readLaunch("#view=activity&access=x")).toBeNull();
	});
});

describe("backlog helpers", () => {
	it("isStale flags only ongoing items whose assignee is not live", () => {
		expect(isStale(snapshotItem("B1", { state: "ongoing", assigneeLive: false }))).toBe(true);
		expect(isStale(snapshotItem("B1", { state: "ongoing" }))).toBe(true);
		expect(isStale(snapshotItem("B1", { state: "ongoing", assigneeLive: true }))).toBe(false);
		expect(isStale(snapshotItem("B1", { state: "todo", assigneeLive: false }))).toBe(false);
	});

	it("cycleTime requires both timestamps and ignores a finish before the start", () => {
		expect(cycleTime(snapshotItem("B1", { startedAt: 10, doneAt: 25 }))).toBe(15);
		expect(cycleTime(snapshotItem("B1", { startedAt: 10 }))).toBeUndefined();
		expect(cycleTime(snapshotItem("B1", { startedAt: 30, doneAt: 20 }))).toBeUndefined();
	});

	it("distinct returns sorted unique values across items", () => {
		const items = [snapshotItem("B1", { tags: ["ui", "api"] }), snapshotItem("B2", { tags: ["api", "db"] })];
		expect(distinct(items, (it) => it.tags)).toEqual(["api", "db", "ui"]);
	});

	it("filterTable filters by assignee and uses each column's first direction when none is given", () => {
		const index = indexBacklog(
			snapshot([
				snapshotItem("B1", { assignee: "kim", notes: [] }),
				snapshotItem("B2", {
					assignee: "lee",
					notes: [
						{ at: 0, author: "a", kind: "note", text: "x" },
						{ at: 0, author: "a", kind: "note", text: "y" },
					],
				}),
				snapshotItem("B3", { assignee: "kim", notes: [{ at: 0, author: "a", kind: "note", text: "x" }] }),
			]),
		);
		expect(filterTable(index, { assignee: "kim" }).map((it) => it.ref)).toEqual(["B1", "B3"]);
		expect(TABLE_COLUMNS.find((column) => column.key === "notes")?.first).toBe("desc");
		expect(filterTable(index, { sort: "notes" }).map((it) => it.ref)).toEqual(["B2", "B3", "B1"]);
		expect(filterTable(index, { sort: "notes", dir: "asc" }).map((it) => it.ref)).toEqual(["B1", "B3", "B2"]);
		expect(filterTable(index, { sort: "ref", dir: "desc" }).map((it) => it.ref)).toEqual(["B3", "B2", "B1"]);
	});

	it("filterBoard treats an untyped item as a task and a whitespace query as no query", () => {
		const index = indexBacklog(snapshot([snapshotItem("B1"), snapshotItem("B2", { type: "epic" })]));
		expect(filterBoard(index, { type: "task" }).map((it) => it.ref)).toEqual(["B1"]);
		expect(filterBoard(index, { q: "   " }).map((it) => it.ref)).toEqual(["B1", "B2"]);
	});

	it("search matches assignees, paths, completions and link targets case-insensitively", () => {
		const index = indexBacklog(
			snapshot([
				snapshotItem("B1", { assignee: "Kim" }),
				snapshotItem("B2", { paths: ["src/Router.ts"] }),
				snapshotItem("B3", {
					links: [{ relation: "related", target: { resource: "external", url: "https://Docs.example" } }],
				}),
			]),
		);
		expect(filterBoard(index, { q: "kim" }).map((it) => it.ref)).toEqual(["B1"]);
		expect(filterBoard(index, { q: "router" }).map((it) => it.ref)).toEqual(["B2"]);
		expect(filterBoard(index, { q: "docs.example" }).map((it) => it.ref)).toEqual(["B3"]);
	});

	it("originChain stops at a cycle and at a missing ancestor", () => {
		const cyclic = indexBacklog(snapshot([snapshotItem("B1", { from: "B2" }), snapshotItem("B2", { from: "B1" })]));
		expect(originChain(cyclic, cyclic.byRef.get("B1")!)).toEqual(["B1", "B2"]);
		const broken = indexBacklog(snapshot([snapshotItem("B1", { from: "B9" })]));
		expect(originChain(broken, broken.byRef.get("B1")!)).toEqual([]);
	});
});

describe("editor rules", () => {
	it("needsCompletion only when saving as done from another state, a new item, or a correction", () => {
		const done = snapshotItem("B1", { state: "done" });
		const todo = snapshotItem("B1", { state: "todo" });
		expect(needsCompletion({ state: "done" })).toBe(true);
		expect(needsCompletion({ state: "done" }, todo)).toBe(true);
		expect(needsCompletion({ state: "done" }, done)).toBe(false);
		expect(needsCompletion({ state: "done" }, done, true)).toBe(true);
		expect(needsCompletion({ state: "todo" }, done, true)).toBe(false);
	});

	it("locksIntent only when a done item stays done", () => {
		expect(locksIntent({ state: "done" }, snapshotItem("B1", { state: "done" }))).toBe(true);
		expect(locksIntent({ state: "todo" }, snapshotItem("B1", { state: "done" }))).toBe(false);
		expect(locksIntent({ state: "done" }, snapshotItem("B1", { state: "todo" }))).toBe(false);
		expect(locksIntent({ state: "done" })).toBe(false);
	});

	it("saves why (never the former reason) and no body", () => {
		const item = snapshotItem("B1", { state: "todo", why: "old why" });
		const mutation = toMutation(
			{ ...editorDefaults(item), why: " new why " },
			{ item, baseVersion: 1, operationKey: "op", states: STATES },
		);
		expect(mutation.why).toBe("new why");
		expect(mutation).not.toHaveProperty("reason");
		expect(mutation).not.toHaveProperty("body");
	});

	it("restores a draft saved before the rename: reason becomes why and changed details join the note", () => {
		const item = snapshotItem("B1", { state: "todo", why: "stored", body: "Stored details" });
		const old = JSON.stringify({ title: "t", reason: "typed why", body: "Typed details", note: "n" });
		expect(restoreDraft(old, item)).toMatchObject({ title: "t", why: "typed why", note: "n\n\nTyped details" });
		const unchanged = JSON.stringify({ reason: "r", body: "Stored details" });
		expect(restoreDraft(unchanged, item)).toMatchObject({ why: "r", note: "" });
		expect(restoreDraft(JSON.stringify({ why: "current", reason: "stale" }), item).why).toBe("current");
		expect(restoreDraft(JSON.stringify({}), item)).not.toHaveProperty("body");
	});

	it("editing a done item without correcting drops goal and why and records no completion", () => {
		const done = snapshotItem("B1", { state: "done", goal: "old goal", why: "old why" });
		const values = { ...editorDefaults(done), goal: "new goal", why: "new why", note: " remember " };
		const mutation = toMutation(values, { item: done, baseVersion: 1, operationKey: "op", states: STATES });
		expect(mutation).not.toHaveProperty("goal");
		expect(mutation).not.toHaveProperty("why");
		expect(mutation).not.toHaveProperty("completion");
		expect(mutation.note).toBe("remember");
	});

	it("keeps an existing external link object when its URL is still listed, and drops unlisted ones", () => {
		const kept = {
			relation: "evidence" as const,
			target: { resource: "external" as const, url: "https://keep.example" },
		};
		const it = snapshotItem("B1", {
			links: [kept, { relation: "related", target: { resource: "external", url: "https://drop.example" } }],
		});
		const values = { ...editorDefaults(it), urls: "https://keep.example\nhttps://new.example" };
		const mutation = toMutation(values, { item: it, baseVersion: 1, operationKey: "op", states: STATES });
		expect(mutation.links).toEqual([
			kept,
			{ relation: "related", target: { resource: "external", url: "https://new.example" } },
		]);
	});

	it("editorDefaults prefills a correction from the latest completion only", () => {
		const it = snapshotItem("B1", {
			state: "done",
			completions: [
				{
					id: 1,
					actor: "a",
					at: 0,
					version: 1,
					goal: "",
					operationKey: "k1",
					summary: "first",
					files: [],
					verification: { status: "failed", summary: "f" },
				},
				{
					id: 2,
					actor: "a",
					at: 1,
					version: 2,
					goal: "",
					operationKey: "k2",
					summary: "second",
					lesson: "learned",
					files: [{ path: "a.ts", role: "produced" }],
					verification: { status: "passed", summary: "ok" },
				},
			],
		});
		expect(editorDefaults(it, true)).toMatchObject({
			summary: "second",
			files: "a.ts",
			verificationStatus: "passed",
			verificationSummary: "ok",
			lesson: "learned",
		});
		expect(editorDefaults(it)).toMatchObject({ summary: "", files: "", verificationStatus: "not_run" });
	});
});
