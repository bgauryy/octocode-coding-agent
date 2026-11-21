import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { backlogToolName, fixtureBacklog, planEntryFields } from "./backlog-fixture.ts";
import { itemCounts } from "./counts-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { USER_AUTHOR } from "../../../db/src/author.ts";
import { type AgentDb, closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb, sharedAgentDb } from "../../src/storage/database.ts";
import { boardRows } from "../../src/octocode/backlog/board-model.ts";
import { showBoard } from "../../src/octocode/backlog/board.ts";
import { countsText, itemDetail, itemLine } from "../../src/octocode/backlog/format.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogError, BacklogStore, type Item, parseRef } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";

const READY = { goal: "Expected result", why: "Required work" };
const completed = () => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed" as const, summary: "Focused check passed" },
	operationKey: crypto.randomUUID(),
});
const KEY = { enter: "\r", escape: "\x1b", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D" };
const SECRET = `ghp_${"a1B2c3D4e5".repeat(4)}`;

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function storeFor(repo: string, db: AgentDb = sharedAgentDb()): BacklogStore {
	return fixtureBacklog(() => db, repo);
}

function workspaceStore(cwd: string): BacklogStore {
	const agent = sharedAgentDb();
	return new BacklogStore(() => agent, registeredWorkspace(cwd, agent).id);
}

/** Record a session row, as the sessions feature does at session_start. */
function session(id: string, pid: number | null, db: AgentDb = sharedAgentDb()): void {
	db.db.prepare(`INSERT INTO sessions (id, pid) VALUES (?, ?)`).run(id, pid);
}

function repoDir(name = "repo"): string {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function setup(options: { isSubagent?: boolean; agentId?: string; parentSession?: string } = {}) {
	const fake = fakeHost();
	const commands = new Subcommands();
	registerBacklog(fake.api, {
		commands,
		isSubagent: options.isSubagent ?? false,
		...(options.agentId ? { agentId: () => options.agentId } : {}),
		...(options.parentSession ? { env: { ...process.env, [PARENT_SESSION_ENV]: options.parentSession } } : {}),
	});
	const cwd = repoDir();
	const tool = fake.tools.get("backlog");
	const plan = fake.tools.get("backlogPlan");
	const call = (params: Record<string, unknown>, ctx = fakeCtx({ cwd })) =>
		fake.tools.get(backlogToolName(params.op)).execute("id", params, undefined, undefined, ctx) as Promise<{
			content: Array<{ text: string }>;
		}>;
	const text = async (params: Record<string, unknown>) => (await call(params)).content[0].text;
	return { ...fake, commands, cwd, tool, plan, call, text, command: commands.get("backlog")! };
}

describe("backlog store", () => {
	it("numbers items per repository and never reuses a number", () => {
		const a = storeFor("repo-a");
		const b = storeFor("repo-b");
		expect(a.add({ ...READY, title: "one", createdBy: "user" }).ref).toBe("B1");
		expect(a.add({ ...READY, title: "two", createdBy: "user" }).ref).toBe("B2");
		expect(b.add({ ...READY, title: "other", createdBy: "user" }).ref).toBe("B1");
		expect(a.add({ ...READY, title: "three", createdBy: "user" }).ref).toBe("B3");
		expect(a.list().items.map((item) => item.title)).toEqual(["three", "two", "one"]);
		expect(parseRef("b7")).toBe(7);
		expect(parseRef("7")).toBe(7);
		expect(parseRef("x")).toBeUndefined();
	});

	it("needs a goal for anything an agent adds, and lets a person add a bare title", () => {
		const store = storeFor("goal");
		expect(() => store.add({ title: "no goal", createdBy: "agent" })).toThrow(/add needs a goal/);
		expect(() => store.add({ title: "blank goal", goal: " \n ", createdBy: "agent:sub-1" })).toThrow(
			/add needs a goal/,
		);
		expect(store.list().items).toEqual([]);
		expect(store.add({ title: "with goal", goal: "tests pass", createdBy: "agent" }).goal).toBe("tests pass");
		expect(store.add({ title: "typed by the user", createdBy: USER_AUTHOR }).goal).toBe("");
	});

	it("defaults to the backlog state and sorts ongoing, then priority, then recent", () => {
		const store = storeFor("r");
		const low = store.add({ ...READY, title: "low", state: "todo", priority: 3, createdBy: "user" });
		store.add({ ...READY, title: "high", state: "todo", priority: 0, createdBy: "user" });
		expect(store.add({ ...READY, title: "idea", createdBy: "agent", goal: "g" }).state).toBe("backlog");
		store.update(low.ref, { state: "ongoing" }, { id: "s1" });
		expect(store.list({ states: ["todo", "ongoing"] }).items.map((item) => item.title)).toEqual(["low", "high"]);
		expect(store.counts().items).toEqual({ backlog: 1, todo: 1, ongoing: 1, done: 0 });
		expect(store.list({ query: "hig" }).items.map((item) => item.title)).toEqual(["high"]);
		expect(store.list({ query: "%" }).items).toEqual([]);
	});

	it("claims ongoing items, refuses a live holder, and takes over a finished one", () => {
		const store = storeFor("r");
		const item = store.add({ ...READY, title: "task", state: "todo", createdBy: "user" });
		session("live", process.ppid);
		session("gone", null);
		expect(store.update(item.ref, { state: "ongoing" }, { id: "live" }).assignee).toBe("live");
		expect(() => store.update(item.ref, { state: "ongoing" }, { id: "me" })).toThrow(
			/ongoing for live, which is still running/,
		);
		store.update(item.ref, { state: "todo" }, { id: "live" });
		expect(store.get(item.ref)!.assignee).toBeUndefined();
		store.update(item.ref, { state: "ongoing" }, { id: "gone" });
		expect(store.update(item.ref, { state: "ongoing" }, { id: "me" }).assignee).toBe("me");
	});

	it("refuses changing an item a live session holds, except to add a note, unless the user forces it", () => {
		const store = storeFor("r");
		const item = store.add({ ...READY, title: "task", state: "todo", createdBy: "user" });
		session("live", process.ppid);
		store.update(item.ref, { state: "ongoing" }, { id: "live" });
		for (const input of [
			{ state: "done" as const, note: "x" },
			{ state: "todo" as const },
			{ title: "renamed" },
			{ priority: 0 },
		])
			expect(() => store.update(item.ref, input, { id: "me" }), JSON.stringify(input)).toThrow(
				/ongoing for live, which is still running/,
			);
		expect(store.update(item.ref, { note: "fyi" }, { id: "me" }).assignee).toBe("live");
		expect(store.update(item.ref, { state: "todo", force: true }, { id: "me" }).assignee).toBeUndefined();
	});

	it("stamps done, logs notes, and refuses a stale version", () => {
		const store = storeFor("r");
		const item = store.add({ ...READY, title: "task", createdBy: "user" });
		const done = store.update(
			item.ref,
			{ state: "done", completion: completed(), note: "shipped; tests pass" },
			{ id: "me" },
		);
		expect(done.doneAt).toBeTypeOf("number");
		expect(done.version).toBe(item.version + 1);
		expect(store.notes(done)).toMatchObject([
			{ author: "me", kind: "change", text: "state backlog → done · completion recorded" },
			{ author: "me", kind: "note", text: "shipped; tests pass" },
		]);
		expect(() => store.update(item.ref, { title: "x", version: item.version }, { id: "me" })).toThrow(
			/changed elsewhere/,
		);
		expect(
			store.update(item.ref, { state: "todo", note: "Reopen to investigate" }, { id: "me" }).doneAt,
		).toBeUndefined();
		expect(() => store.update(item.ref, { close: { kind: "obsolete", text: "x" } }, { id: "me" })).not.toThrow();
		expect(store.get(item.ref)?.completions).toHaveLength(1);
	});

	it("sanitizes stored text and normalizes tags", () => {
		const store = storeFor("r");
		const item = store.add({
			...READY,
			title: "bad\u001b]0;pwned\u0007 title",
			tags: ["#UI", "ui", "a b", ""],
			createdBy: "user",
		});
		expect(item.title).toBe("bad title");
		expect(item.tags).toEqual(["ui", "a-b"]);
	});

	it("refuses secrets on the stored (sanitized) text of title, plan, note and tags", () => {
		const store = storeFor("r");
		const hidden = `ghp_\u200b${"a1B2c3D4e5".repeat(4)}`;
		expect(() => store.add({ ...READY, title: hidden, createdBy: "user" })).toThrow(BacklogError);
		expect(() => store.add({ ...READY, title: "ok", plan: `use ${hidden}`, createdBy: "user" })).toThrow(
			/plan .*secret/,
		);
		expect(() => store.add({ ...READY, title: "ok", tags: ["AKIAIOSFODNN7EXAMPLE"], createdBy: "user" })).toThrow(
			/tags .*secret/,
		);
		const item = store.add({ ...READY, title: "ok", createdBy: "user" });
		expect(() => store.update(item.ref, { note: hidden }, { id: "me" })).toThrow(/note .*secret/);
		expect(() => store.update(item.ref, { title: hidden }, { id: "me" })).toThrow(/secret/);
		expect(store.list().items).toHaveLength(1);
		expect(store.noteCount(item)).toBe(0);
	});

	it("lets a subagent touch only items its owners hold", () => {
		const store = storeFor("r");
		const mine = store.add({ ...READY, title: "given", state: "todo", createdBy: "user" });
		const other = store.add({ ...READY, title: "other", state: "todo", createdBy: "user" });
		store.update(mine.ref, { state: "ongoing" }, { id: "parent" });
		const sub = { id: "sub-1", owners: new Set(["parent"]) };
		expect(() => store.update(other.ref, { state: "ongoing" }, sub)).toThrow(BacklogError);
		expect(store.update(mine.ref, { state: "done", completion: completed(), note: "did it" }, sub).state).toBe("done");
	});

	it("links an item to the one it came from, lists those derived from it, and refuses unknown, self and loop links", () => {
		const store = storeFor("r");
		const root = store.add({ ...READY, title: "root", state: "todo", createdBy: "user" });
		const split = store.add({ ...READY, title: "split", from: "b1", createdBy: "agent", goal: "g" });
		const followUp = store.add({
			...READY,
			title: "follow-up",
			from: "B1",
			state: "todo",
			createdBy: "agent",
			goal: "g",
		});
		const grandchild = store.add({
			...READY,
			title: "grandchild",
			from: split.ref,
			createdBy: "agent",
			goal: "g",
		});
		expect(split.from).toBe(1);
		expect(store.notes(split)).toMatchObject([{ author: "agent", kind: "change", text: "created from B1" }]);
		expect(store.derived(root).map((item) => item.ref)).toEqual([followUp.ref, split.ref]);
		expect(store.list({ from: "B1" }).items.map((item) => item.ref)).toEqual([followUp.ref, split.ref]);
		expect(store.list({ from: "B1", states: ["todo"] })).toMatchObject({
			total: 1,
			items: [{ ref: followUp.ref }],
		});
		expect(() => store.add({ ...READY, title: "orphan", from: "B99", createdBy: "agent", goal: "g" })).toThrow(
			/No backlog item B99 to link from/,
		);
		expect(() =>
			storeFor("other-repo").add({ ...READY, title: "x", from: "B1", createdBy: "agent", goal: "g" }),
		).toThrow(/No backlog item B1/);
		expect(() => store.update(root.ref, { from: root.ref }, { id: "me" })).toThrow(/cannot come from itself/);
		expect(() => store.update(root.ref, { from: grandchild.ref }, { id: "me" })).toThrow(
			/B4 already comes from B1: the link would make a loop/,
		);
		expect(store.update(grandchild.ref, { from: root.ref }, { id: "me" }).from).toBe(1);
		expect(store.update(grandchild.ref, { from: null }, { id: "me" }).from).toBeUndefined();
		expect(store.notes(grandchild).map((note) => note.text)).toEqual([
			"created from B2",
			"from B2 → B1",
			"from B1 → none",
		]);
	});

	it("logs every field an update changes, keeps a replaced plan in full, and logs nothing for a note or a no-op", () => {
		const store = storeFor("r");
		const plan = `why: ${"evidence ".repeat(300)}`.trim();
		const item = store.add({
			...READY,
			title: "old title",
			plan,
			tags: ["a"],
			state: "todo",
			createdBy: "user",
		});
		store.update(
			item.ref,
			{ title: "new title", plan: "rewritten", priority: 0, tags: ["b", "c"], state: "ongoing" },
			{ id: "s1" },
		);
		store.update(item.ref, { note: "why I changed it" }, { id: "s1" });
		store.update(item.ref, { priority: 0, tags: ["b", "c"], title: "new title" }, { id: "s1" });
		const notes = store.notes(item, 50);
		expect(notes.map((note) => note.kind)).toEqual(["change", "note"]);
		expect(notes[0].text).toBe(
			`state todo → ongoing · assignee none → s1 · priority p2 → p0 · tags #a → #b #c · title was "old title" · plan replaced; it was:\n${plan}`,
		);
		expect(plan.length).toBeGreaterThan(1000);
		const blank = store.add({ ...READY, title: "blank", createdBy: "user" });
		expect(store.notes(store.update(blank.ref, { plan: "first text" }, { id: "s1" }))[0].text).toBe("plan added");
	});

	it("matches a query against title and body substrings but only whole tags", () => {
		const store = storeFor("r");
		store.add({ ...READY, title: "build cache", tags: ["infra"], createdBy: "user" });
		store.add({ ...READY, title: "menu", tags: ["ui"], createdBy: "user" });
		expect(store.list({ query: "ui" }).items.map((item) => item.title)).toEqual(["menu", "build cache"]);
		expect(store.list({ query: "#ui" }).items.map((item) => item.title)).toEqual(["menu"]);
		expect(store.list({ query: "infr" }).items).toEqual([]);
		expect(store.list({ query: "infra" }).items.map((item) => item.title)).toEqual(["build cache"]);
	});

	it("keeps separate databases apart", () => {
		const db = openAgentDb(path.join(tmp, "other.db"));
		try {
			storeFor("r", db).add({ ...READY, title: "elsewhere", createdBy: "user" });
			expect(storeFor("r").list().items).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe("backlog done-item corrections", () => {
	it("lets only the user force a correction of a done item's why; the goal stays locked", () => {
		const store = workspaceStore(repoDir());
		const item = store.add({ ...READY, title: "t", createdBy: "agent", state: "todo" });
		store.update(item.ref, { state: "done", completion: completed() }, { id: "agent-1" });
		expect(() => store.update(item.ref, { why: "x", force: true }, { id: "agent-1" })).toThrow(/Reopen before/);
		expect(() => store.update(item.ref, { goal: "y", force: true }, { id: "user" })).toThrow(/Reopen before/);
		expect(store.update(item.ref, { why: "Restored", force: true }, { id: "user" }).why).toBe("Restored");
	});
});

describe("backlog tool", () => {
	it("pages every matching item and every note with executable continuations", async () => {
		const t = setup();
		for (let i = 0; i < 53; i++)
			await t.text({
				op: "add",
				items: [{ why: "Required work", title: `Task ${i}`, goal: "it works", state: "todo" }],
			});
		const next = (text: string) => JSON.parse(text.match(/^Next: backlog(?:Plan)? (.+)$/m)![1]);
		const first = await t.text({ op: "list", limit: 50 });
		const second = await t.text(next(first));
		const ids = [...`${first}\n${second}`.matchAll(/^(B\d+) \[/gm)].map((match) => match[1]);
		expect(ids).toHaveLength(53);
		expect(new Set(ids).size).toBe(53);
		expect(second).not.toContain("Next:");

		for (let i = 0; i < 23; i++) await t.text({ op: "note", id: "B1", note: `note-${i}` });
		const pages: string[] = [];
		let page = await t.text({ op: "get", id: "B1" });
		while (true) {
			pages.push(page);
			if (!page.includes("Next: backlog")) break;
			expect(pages.length).toBeLessThan(4);
			page = await t.text(next(page));
		}
		const notes = [...pages.join("\n").matchAll(/: (note-\d+)$/gm)].map((match) => match[1]);
		expect(notes).toHaveLength(23);
		expect(new Set(notes).size).toBe(23);
	});

	it("adds proposals to backlog, lists proposed items with open work, and gets details", async () => {
		const t = setup();
		expect(
			await t.text({
				op: "add",
				items: [
					{
						title: "Add memory tool",
						why: "Required work",
						goal: "it works",
						plan: "with BM25",
						priority: "p1",
						tags: ["mem"],
					},
				],
			}),
		).toBe("Added B1 [backlog p1] Add memory tool #mem");
		await t.text({ op: "add", items: [{ why: "Required work", title: "Accepted", goal: "it works", state: "todo" }] });
		expect(await t.text({ op: "list" })).toBe("B2 [todo p2] Accepted\nB1 [backlog p1] Add memory tool #mem");
		expect(await t.text({ op: "claim", id: "B1", note: "starting" })).toMatch(/^Updated B1 \[ongoing p1\] v\d+$/);
		const detail = await t.text({ op: "get", id: "b1", changes: true });
		expect(detail).toContain("B1 [ongoing p1] Add memory tool #mem (you)");
		expect(detail).toContain("with BM25");
		expect(detail).toMatch(
			/Notes and changes:\n- .* ago you · state backlog → ongoing · assignee none → \S+\n- .* ago you: starting/,
		);
		expect(detail).toMatch(/version 2/);
		expect(await t.text({ op: "list", states: ["todo"], limit: 1, query: "Acc" })).toContain("B2 [todo p2] Accepted");
	});

	it("requires a note to finish and refuses secrets", async () => {
		const t = setup();
		await t.text({ op: "add", items: [{ why: "Required work", title: "task", goal: "it works", state: "todo" }] });
		await expect(t.call({ op: "done", id: "B1" })).rejects.toThrow(/needs completion/);
		await expect(
			t.call({ op: "add", items: [{ why: "Required work", title: "token", goal: "it works", plan: `use ${SECRET}` }] }),
		).rejects.toThrow(/secret/);
		await expect(t.call({ op: "note", id: "B1", note: SECRET })).rejects.toThrow(/secret/);
		await expect(t.call({ op: "edit", items: [{ id: "B1", tags: [SECRET] }] })).rejects.toThrow(/secret/);
		// A secret note on add is refused before anything is stored (the store's rule; the tool's add takes no note).
		expect(() =>
			workspaceStore(t.cwd).add({
				why: "Required work",
				title: "fast",
				goal: "it works",
				state: "done",
				note: SECRET,
				createdBy: "agent",
			}),
		).toThrow(/secret/);
		expect(await t.text({ op: "list", states: ["todo"] })).toBe("B1 [todo p2] task");
		await expect(t.call({ op: "edit", items: [{ id: "B1" }] })).rejects.toThrow(/needs something to change/);
		await expect(t.call({ op: "get" })).rejects.toThrow(/needs an id/);
		await expect(t.call({ op: "get", id: "B9" })).rejects.toThrow(/No backlog item B9/);
		expect(
			await t.text({
				op: "done",
				id: "B1",
				completion: completed(),
				note: "fixed; yarn test passes",
			}),
		).toMatch(/^Updated B1 \[done p2\] v\d+$/);
		expect(t.tool.executionMode).toBeUndefined();
		expect(t.tool.parameters.properties.op.enum).toEqual(["get", "claim", "note", "done", "close", "step"]);
		expect(t.plan.parameters.properties.op.enum).toEqual(["add", "edit", "list", "stat"]);
	});

	it("refuses an add it cannot complete before creating anything, so a retry leaves no duplicate", async () => {
		const t = setup();
		// The store's rules for an item added in its final state, which the web board and RPC callers reach.
		const store = workspaceStore(t.cwd);
		const shipped = { why: "Required work", title: "shipped", goal: "it works", createdBy: "agent" };
		expect(() => store.add({ ...shipped, state: "done" })).toThrow(/completion/);
		expect(() => store.add({ ...shipped, title: "idea", note: "context" })).toThrow(
			/note only with state ongoing or done/,
		);
		// The tool's add plans: finishing is a `backlog` operation, named in the refusal.
		await expect(
			t.call({ op: "add", items: [{ why: "Required work", title: "shipped", goal: "it works", state: "done" }] }),
		).rejects.toThrow("backlogPlan does not finish an item: use backlog with op done and its completion.");
		await expect(
			t.call({ op: "add", items: [{ why: "Required work", title: "idea", goal: "it works", note: "context" }] }),
		).rejects.toThrow(/note only with state ongoing or done/);
		await expect(
			t.call({
				op: "add",
				items: [{ why: "Required work", title: "idea", goal: "it works", completion: completed() }],
			}),
		).rejects.toThrow("backlogPlan does not take completion: use backlog with op done.");
		expect(workspaceStore(t.cwd).counts().items).toMatchObject({ backlog: 0, todo: 0, done: 0 });
		expect(store.add({ ...shipped, state: "done", completion: completed(), note: "merged; tests pass" }).state).toBe(
			"done",
		);
		expect(await t.text({ op: "add", items: [{ why: "Required work", title: "next", goal: "it works" }] })).toMatch(
			/^Added B2 \[backlog/,
		);
		expect(await t.text({ op: "done", id: "B2", completion: completed(), note: "merged; tests pass" })).toMatch(
			/^Updated B2 \[done/,
		);
	});

	it("closes an item without deleting it, but not one another live session holds", async () => {
		const t = setup();
		await t.text({ op: "add", items: [{ why: "Required work", title: "dup", goal: "it works", state: "todo" }] });
		await t.text({ op: "note", id: "B1", note: "a note" });
		expect(
			await t.text({ op: "close", id: "b1", close: { kind: "obsolete", text: "superseded by the rewrite" } }),
		).toMatch(/^Updated B1 \[closed/);
		expect(await t.text({ op: "get", id: "B1" })).toContain("Closed (obsolete): superseded by the rewrite");
		await expect(t.call({ op: "close", close: { kind: "obsolete", text: "x" } })).rejects.toThrow(/needs an id/);
		await t.text({ op: "add", items: [{ why: "Required work", title: "held", goal: "it works", state: "todo" }] });
		session("other-session", process.ppid);
		workspaceStore(t.cwd).update("B2", { state: "ongoing" }, { id: "other-session" });
		await expect(t.call({ op: "close", id: "B2", close: { kind: "wont_do", text: "not worth it" } })).rejects.toThrow(
			/ongoing for other-session/,
		);
	});

	it("refuses to claim an item another live session holds, naming it", async () => {
		const t = setup();
		await t.text({ op: "add", items: [{ why: "Required work", title: "task", goal: "it works", state: "todo" }] });
		session("other-session", process.ppid);
		workspaceStore(t.cwd).update("B1", { state: "ongoing" }, { id: "other-session" });
		await expect(t.call({ op: "claim", id: "B1" })).rejects.toThrow(/other-session/);
	});

	it("in a subagent: adds only to backlog and updates only its or its coordinator's items", async () => {
		const parent = setup();
		await parent.text({
			op: "add",
			items: [
				{
					why: "Required work",
					title: "delegated",
					goal: "it works",
					state: "todo",
				},
			],
		});
		await parent.text({
			op: "add",
			items: [
				{
					why: "Required work",
					title: "unrelated",
					goal: "it works",
					state: "todo",
				},
			],
		});
		workspaceStore(parent.cwd).update("B1", { state: "ongoing" }, { id: "parent-session" });
		const sub = setup({ isSubagent: true, agentId: "general-1", parentSession: "parent-session" });
		// A child gets the work operations only: it never declares `backlogPlan` (its coordinator files follow-ups).
		expect(sub.tool.parameters.properties.op.enum).toEqual(["get", "claim", "note", "done", "close", "step"]);
		expect(sub.tool.parameters).toEqual(parent.tool.parameters);
		expect(sub.tool.parameters.properties).not.toHaveProperty("state");
		expect(sub.plan.defaultActive).toBe(false);
		expect(parent.plan.defaultActive).toBe(true);
		// The description is the same for every role (it leads the cached prefix); the limits are in the refusals below.
		expect(sub.tool.description).toBe(parent.tool.description);
		expect(await sub.text({ op: "list" })).toBe("B1 [ongoing p2] delegated (coordinator)\nB2 [todo p2] unrelated");
		expect(
			await sub.text({
				op: "add",
				items: [
					{
						why: "Required work",
						title: "follow-up",
						goal: "it works",
						state: "todo",
					},
				],
			}),
		).toBe("Added B3 [backlog p2] follow-up");
		expect(workspaceStore(sub.cwd).get("B3")!.createdBy).toBe("agent:general-1");
		// A proposal takes no note, and the parent has not claimed it, so the hint points at plan, not a later update.
		await expect(
			sub.call({ op: "add", items: [{ why: "Required work", title: "with note", goal: "it works", note: "details" }] }),
		).rejects.toThrow("A subagent adds without a note: put the details in plan or evidence.");
		// The child cannot write hierarchy or dependencies: its tool has no field for them, and the store refuses them
		// on add and edit with a message naming each.
		const childProperties = sub.tool.parameters.properties as Record<string, { description?: string }>;
		for (const field of ["reason", "body", "parentId", "dependsOn"])
			expect(Object.keys(childProperties)).not.toContain(field);
		await expect(sub.call({ op: "edit", items: [{ id: "B1", parentId: "B2" }] })).rejects.toThrow(
			/only the state and notes/,
		);
		await expect(sub.call({ op: "edit", items: [{ id: "B1", dependsOn: ["B2"] }] })).rejects.toThrow(
			/only the state and notes/,
		);
		expect(sub.tool.parameters.properties).toHaveProperty("completion");
		// Links are a `backlogPlan` entry's field, never a top-level one of `backlog`.
		expect(sub.tool.parameters.properties).not.toHaveProperty("links");
		await expect(
			sub.call({ op: "add", items: [{ ...READY, title: "linked", parentId: "B1", links: [], dependsOn: ["B1"] }] }),
		).rejects.toThrow("A subagent proposal cannot set parentId, dependsOn:");
		// A proposal may carry references as links (shorthands expand as for the parent); an update still may not.
		await sub.text({
			op: "add",
			items: [{ ...READY, title: "referenced", links: [{ relation: "output", target: "docs/r.md" }] }],
		});
		expect(workspaceStore(sub.cwd).get("B4")!.links).toEqual([
			{
				relation: "output",
				target: { resource: "files", repositoryKey: workspaceStore(sub.cwd).repo, path: "docs/r.md" },
			},
		]);
		await expect(sub.call({ op: "edit", items: [{ id: "B1", links: [] }] })).rejects.toThrow(
			/only the state and notes/,
		);
		await expect(sub.call({ op: "claim", id: "B2" })).rejects.toThrow(/not claimed by your coordinator/);
		await expect(sub.call({ op: "edit", items: [{ id: "B1", title: "renamed" }] })).rejects.toThrow(
			/only the state and notes/,
		);
		await expect(sub.call({ op: "edit", items: [{ id: "B1", state: "todo" }] })).rejects.toThrow(
			/sets only ongoing or done/,
		);
		expect(workspaceStore(sub.cwd).get("B1")!.state).toBe("ongoing");
		expect(
			await sub.text({
				op: "done",
				id: "B1",
				completion: completed(),
				note: "done; verified",
			}),
		).toMatch(/^Updated B1 \[done p2\] v\d+$/);
		await expect(sub.call({ op: "close", id: "B3", close: { kind: "obsolete", text: "not needed" } })).rejects.toThrow(
			/not claimed by your coordinator/,
		);
	});

	it("in a subagent: why and goal on a parent-owned claim are kept as the parent set them, with a note", async () => {
		const parent = setup();
		await parent.text({
			op: "add",
			items: [{ why: "Parent reason", title: "delegated", goal: "parent goal", state: "todo" }],
		});
		workspaceStore(parent.cwd).update("B1", { state: "ongoing" }, { id: "parent-session" });
		const sub = setup({ isSubagent: true, agentId: "general-1", parentSession: "parent-session" });
		// The description says a claim needs why and goal, so a child that sends them is not refused.
		const result = await sub.text({
			op: "claim",
			id: "B1",
			why: "child reason",
			goal: "child goal",
			note: "started",
		});
		expect(result).toMatch(/^Updated B1 \[ongoing p2\] v\d+\n\(goal\/why kept: your coordinator owns them\.\)$/);
		const item = workspaceStore(sub.cwd).get("B1")!;
		expect([item.why, item.goal]).toEqual(["Parent reason", "parent goal"]);
		// The permission rule stands: the other fields stay the parent's, and so does an item it has not claimed.
		await expect(sub.call({ op: "edit", items: [{ id: "B1", why: "x", title: "renamed" }] })).rejects.toThrow(
			/only the state and notes/,
		);
		await parent.text({ op: "add", items: [{ why: "Other", title: "unclaimed", goal: "g", state: "todo" }] });
		await expect(sub.call({ op: "claim", id: "B2", why: "w", goal: "g" })).rejects.toThrow(
			/not claimed by your coordinator/,
		);
	});

	it("keeps strict link validation in the store behind the compact tool schema", async () => {
		const t = setup();
		const target = { resource: "files", repositoryKey: "repo", path: "src/a.ts" };
		await t.text({ op: "add", items: [{ ...READY, title: "linked", links: [{ relation: "evidence", target }] }] });
		await expect(
			t.call({
				op: "add",
				items: [
					{
						...READY,
						title: "bad",
						links: [{ relation: "evidence", target: { resource: "files" } }],
					},
				],
			}),
		).rejects.toThrow(/Invalid backlog entity fields at \/links\/0\/target/);
		await expect(
			t.call({
				op: "done",
				id: "B1",
				note: "x",
				completion: {
					summary: "s",
					files: [],
					verification: { status: "passed", summary: "v", extra: 1 },
					operationKey: "k",
				},
			}),
		).rejects.toThrow(/Unknown completion\.verification fields: extra/);
	});

	it("keeps why apart from the call reason, expands reference shorthands, and shows links and completion ids", async () => {
		const t = setup();
		await expect(t.call({ op: "add", items: [{ title: "no reason", goal: "it works" }] })).rejects.toThrow(
			/add needs why/,
		);
		await t.text({ op: "add", items: [{ ...READY, title: "origin", state: "todo" }] });
		const links = [
			{ relation: "output", target: "./.octocode/x/report.md" },
			{ relation: "related", target: "https://example.com/issues/1" },
			{ relation: "derived_from", target: "b1" },
			{ relation: "evidence", target: { resource: "files", path: "src/a.ts" } },
		];
		await t.text({
			op: "add",
			reason: "Track it",
			items: [
				{
					why: "User asked",
					title: "tracked",
					goal: "g",
					state: "ongoing",
					links,
				},
			],
		});
		await t.text({ op: "done", id: "B2", reason: "Close it", completion: completed() });
		const detail = await t.text({ op: "get", id: "B2" });
		expect(detail).toMatch(/^Why: User asked$/m);
		for (const line of [
			"- output: .octocode/x/report.md",
			"- related: https://example.com/issues/1",
			"- derived_from: B1",
			"- evidence: src/a.ts",
		])
			expect(detail).toContain(line);
		const id = Number(detail.match(/^Result \(completion (\d+)\): Implemented$/m)![1]);
		await expect(t.call({ op: "done", id: "B2", completion: { ...completed(), replaces: id + 99 } })).rejects.toThrow(
			`B2 is done: a correction replaces the latest completion, ${id}; omit completion.replaces`,
		);
		await t.text({ op: "done", id: "B2", completion: { ...completed(), summary: "Fixed", replaces: id } });
		expect(await t.text({ op: "get", id: "B2" })).toMatch(/^Result \(completion \d+\): Fixed$/m);
		// Without replaces, a new completion on a done item replaces the latest one, and a retry of it is a no-op.
		const store = workspaceStore(t.cwd);
		const fixed = store.get("B2")!.completions.at(-1)!.id;
		const again = { ...completed(), summary: "Fixed again" };
		await t.text({ op: "done", id: "B2", completion: again });
		await t.text({ op: "done", id: "B2", completion: again });
		const history = store.get("B2")!.completions;
		expect(history).toHaveLength(3);
		expect(history.at(-1)).toMatchObject({ summary: "Fixed again", replaces: fixed });
		expect(await t.text({ op: "get", id: "B2" })).toMatch(/^Result \(completion \d+\): Fixed again$/m);
	});

	it("links follow-ups with from: shows the origin and derived items in get, filters list, and lets a subagent link only on add", async () => {
		const t = setup();
		await t.text({ op: "add", items: [{ why: "Required work", title: "Root task", goal: "it works", state: "todo" }] });
		expect(
			await t.text({ op: "add", items: [{ why: "Required work", title: "Follow-up", goal: "it works", from: "B1" }] }),
		).toBe("Added B2 [backlog p2] Follow-up (from B1)");
		const root = await t.text({ op: "get", id: "B1" });
		expect(root).toContain("Derived items (1):\n- B2 [backlog p2] Follow-up (from B1)");
		const child = await t.text({ op: "get", id: "B2", changes: true });
		expect(child).toContain("From: B1 [todo p2] Root task");
		expect(child).toMatch(/- .* ago agent · created from B1/);
		expect(await t.text({ op: "list", derivedFrom: "B1", states: ["backlog"] })).toBe(
			"B2 [backlog p2] Follow-up (from B1)",
		);
		expect(await t.text({ op: "edit", items: [{ id: "B2", from: "" }] })).toMatch(/^Updated B2 \[backlog p2\] v\d+$/);
		await expect(
			t.call({ op: "add", items: [{ why: "Required work", title: "x", goal: "it works", from: "B9" }] }),
		).rejects.toThrow(/No backlog item B9 to link from/);
		expect(rendered(t.plan.renderCall({ op: "add", from: "B1" }, theme, {}))).toContain("from B1");

		workspaceStore(t.cwd).update("B1", { state: "ongoing" }, { id: "parent-session" });
		const sub = setup({ isSubagent: true, agentId: "general-1", parentSession: "parent-session" });
		expect(
			await sub.text({
				op: "add",
				items: [
					{
						why: "Required work",
						title: "Found while working",
						goal: "it works",
						from: "B1",
					},
				],
			}),
		).toBe("Added B3 [backlog p2] Found while working (from B1)");
		await expect(sub.call({ op: "edit", items: [{ id: "B1", from: "B3" }] })).rejects.toThrow(
			/only the state and notes/,
		);
	});

	it("keeps guideline size bounded and schema fields documented", () => {
		for (const [t, max] of [
			[setup(), 2],
			[setup({ isSubagent: true }), 1],
		] as const) {
			const guidelines: string[] = t.tool.promptGuidelines;
			expect(guidelines.length).toBeLessThanOrEqual(max);
			for (const line of guidelines) expect(line.length, line).toBeLessThanOrEqual(230);
			for (const [name, schema] of Object.entries(
				t.tool.parameters.properties as Record<string, { description?: string }>,
			))
				expect(schema.description, name).toBeTruthy();
		}
	});

	it("renders a call line and refreshes the footer counts after a call", async () => {
		const t = setup();
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.call({ op: "add", items: [{ why: "Required work", title: "one", goal: "it works", state: "todo" }] }, ctx);
		expect(ctx.ui.statuses.get("octocode-backlog")).toBe("/web · backlogs & activity · 1 todo");
		await t.call({ op: "claim", id: "B1" }, ctx);
		expect(ctx.ui.statuses.get("octocode-backlog")).toBe("/web · backlogs & activity · 1 ongoing");
		// Items live on the board (`/backlog`), not in a widget under the editor.
		expect(ctx.ui.widgets.has("octocode-backlog")).toBe(false);
		await t.call({ op: "done", id: "B1", completion: completed(), note: "ok" }, ctx);
		expect(ctx.ui.statuses.get("octocode-backlog")).toBe("/web · backlogs & activity");
		expect(rendered(t.tool.renderCall({ op: "done", id: "B1" }, theme, {}))).toBe("⏺ Backlog(done B1)");
		// A call stored before the tool was split (`op` update with a state) still draws as it did.
		expect(rendered(t.tool.renderCall({ op: "update", id: "B1", state: "done" }, theme, {}))).toBe(
			"⏺ Backlog(update B1 → done)",
		);
		expect(rendered(t.plan.renderCall({ op: "edit", id: "B1", state: "todo" }, theme, {}))).toBe(
			"⏺ Backlog plan(edit B1 → todo)",
		);
		const row = async (params: Record<string, unknown>) =>
			rendered(
				t[backlogToolName(params.op) === "backlog" ? "tool" : "plan"].renderResult(
					await t.call(params, ctx),
					{ expanded: false },
					theme,
					{
						args: params,
						isPartial: false,
						expanded: false,
					},
				),
			);
		expect(await row({ op: "add", items: [{ why: "Required work", title: "two", goal: "it works" }] })).toBe(
			"  ⎿  Added B2 · backlog · two",
		);
		expect(await row({ op: "edit", items: [{ id: "B2", state: "todo" }] })).toBe("  ⎿  B2 → todo · two");
		expect(await row({ op: "list", states: ["todo", "done"], limit: 1 })).toMatch(/^ {2}⎿ {2}1 of 2 items\n {5}B\d \[/);
		expect(await row({ op: "list", states: ["ongoing"] })).toMatch(/^ {2}⎿ {2}No items/);
		expect(await row({ op: "get", id: "B2" })).toMatch(/^ {2}⎿ {2}B2 · todo · two\n/);
		expect(await row({ op: "close", id: "B2", close: { kind: "wont_do", text: "not needed" } })).toBe(
			"  ⎿  B2 → closed · two",
		);
		expect(
			rendered(
				t.tool.renderResult({ content: [{ type: "text", text: "No backlog item B9" }] }, {}, theme, {
					args: { op: "get" },
					isError: true,
				}),
			),
		).toBe("  ⎿  Error: No backlog item B9");
	});
});

describe("backlog status", () => {
	it("names every open state and keeps the web hint when there are no open items", () => {
		expect(countsText(itemCounts({ ongoing: 2, todo: 4, backlog: 1, done: 9 }))).toBe(
			"/web · backlogs & activity · 2 ongoing · 4 todo · 1 backlog",
		);
		expect(countsText(itemCounts({ ongoing: 0, todo: 0, backlog: 0, done: 3 }))).toBe("/web · backlogs & activity");
	});

	it("shows the web workspace hint at session start before any item exists", async () => {
		const t = setup();
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.emit("session_start", {}, ctx);
		expect(ctx.ui.statuses.get("octocode-backlog")).toBe("/web · backlogs & activity");
	});

	it("gives RPC clients the same status text and clears it when the database becomes unreadable", async () => {
		const t = setup();
		const rpc = fakeCtx({ cwd: t.cwd, mode: "rpc" });
		await t.call({ op: "add", items: [{ why: "Required work", title: "one", goal: "it works", state: "todo" }] }, rpc);
		await t.call({ op: "claim", id: "B1" }, rpc);
		expect(rpc.ui.statuses.get("octocode-backlog")).toBe("/web · backlogs & activity · 1 ongoing");
		expect(rpc.ui.widgets.has("octocode-backlog")).toBe(false);
		const db = path.join(t.cwd, "foreign.sqlite");
		fs.writeFileSync(db, "not sqlite at all, not even close to a header of one".repeat(20));
		// afterEach restores OCTOCODE_AGENT_DB.
		closeSharedAgentDb();
		process.env.OCTOCODE_AGENT_DB = db;
		await t.handlers.get("agent_end")![0]({}, rpc);
		expect(rpc.ui.statuses.get("octocode-backlog")).toBeUndefined();
		expect(rpc.ui.widgets.has("octocode-backlog")).toBe(false);
	});
});

describe("/backlog", () => {
	it("shows controls in a query, a ref and an id the model sent as visible escapes in its answers", async () => {
		const t = setup();
		expect(await t.text({ op: "list", query: "zz\u001b[2J\u202e" })).toContain('matching "zz\\u{1b}[2J\\u{202e}"');
		await expect(t.call({ op: "get", id: "B9\u001b]0;x\u0007" })).rejects.toThrow(
			"No backlog item B9\\u{1b}]0;x\\u{7}.",
		);
		expect(() =>
			storeFor("repo").add({ ...READY, title: "x", from: "B9\u200b", createdBy: "agent", goal: "g" }),
		).toThrow(/No backlog item B9\\u\{200b\} to link from/);
	});

	it("formats an item with controls (a row written by another build) as visible escapes", () => {
		const item = {
			rowId: 1,
			seq: 1,
			ref: "B1",
			title: "fix\u001b[2Jit",
			goal: "g\u202e",
			body: "a\u0000b",
			paths: ["p\u200bq"],
			why: "",
			evidence: ["e\u0007"],
			plan: "",
			state: "ongoing",
			priority: 1,
			tags: [],
			assignee: "who\u009d",
			createdBy: "me\u001b",
			createdAt: 0,
			updatedAt: 0,
			startedAt: 0,
			version: 1,
			type: "feature",
			dependsOn: [],
			links: [],
			completions: [],
		} as unknown as Item;
		expect(itemLine(item)).toBe("B1 [ongoing p1] fix\\u{1b}[2Jit (@who\\u{9d})");
		const detail = itemDetail(item, [], 0, 0);
		expect(detail).toContain("Done when: g\\u{202e}");
		expect(detail).toContain("Where: p\\u{200b}q");
		expect(detail).toContain("- e\\u{7}");
		expect(detail).toContain("a\\u{0}b");
		expect(detail).not.toMatch(/[\u0000-\u0008\u001b\u009d\u200b\u202e]/u);
	});

	it("works headless: add, list, move, detail, export", async () => {
		const t = setup();
		const ctx = fakeCtx({
			cwd: t.cwd,
			hasUI: false,
			ui: { inputs: ["Required work", "Docs are complete", "Docs written", "docs/guide.md"] },
		});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await t.command.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/empty/);
		// Print mode has no notify surface: the text goes to stderr too.
		expect(String(stderr.mock.calls.at(-1)?.[0])).toMatch(/empty/);
		stderr.mockRestore();
		await t.command.handler("add Write the docs", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toBe("Added B1 [todo p2] Write the docs");
		await t.command.handler("B1 ongoing", ctx);
		await t.command.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toBe("Ongoing (1)\n  B1 [ongoing p2] Write the docs (you)");
		await t.command.handler("B1", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/claimed .+ ago by you/);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/version \d/);
		await t.command.handler("B1 done", ctx);
		await t.command.handler("B9", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({ type: "warning" });
		await t.command.handler("export", ctx);
		const file = path.join(t.cwd, ".octocode", "code", "backlog.md");
		expect(ctx.ui.notes.at(-1)!.message).toContain(file);
		const markdown = fs.readFileSync(file, "utf8");
		expect(markdown).toMatch(/^<!-- Generated by Octocode .* not read back\. -->/);
		expect(markdown).toContain("## Done (1)\n\n- **B1** [p2] Write the docs");
		expect(t.commands.complete("backlog B")?.map((item) => item.value)).toContain("backlog B1");
		expect(t.commands.complete("backlog do B")?.map((item) => item.value)).toContain("backlog do B1");
		expect(t.commands.complete("backlog e")).toEqual([expect.objectContaining({ value: "backlog export" })]);
		expect(t.commands.complete("backlog B1 d")!.map((item) => item.value)).toEqual(["backlog B1 done"]);
		expect(t.commands.complete("backlog B1 c")!.map((item) => item.value)).toEqual(["backlog B1 close"]);
	});

	it('"do" marks the item ongoing and sends it to the agent, as a follow-up while busy', async () => {
		const t = setup();
		workspaceStore(t.cwd).add({
			...READY,
			title: "Fix login",
			goal: "Login submits without freezing; focused tests pass.",
			plan: "The form hangs.",
			state: "todo",
			createdBy: "user",
		});
		await t.command.handler("do B1", fakeCtx({ cwd: t.cwd, hasUI: false }));
		const sent = t.sent.at(-1)!;
		expect(sent.options).toBeUndefined();

		expect(sent.message).toContain("B1 [ongoing p2] Fix login");
		expect(sent.message).toContain("Done when: Login submits without freezing; focused tests pass.");
		expect(sent.message).toContain("The form hangs.");
		expect(sent.message).toContain("from: B1");
		expect(workspaceStore(t.cwd).get("B1")).toMatchObject({
			state: "ongoing",
			assignee: "session-test",
		});
		await t.command.handler("do B1", fakeCtx({ cwd: t.cwd, hasUI: false, idle: false }));
		expect(t.sent.at(-1)!.options).toEqual({ deliverAs: "followUp" });
	});

	it("falls back to select lists without a custom component: actions, move, priority, delegate, close", async () => {
		const t = setup();
		const store = workspaceStore(t.cwd);
		store.add({
			...READY,
			title: "first",
			goal: "The selected action changes the item and repaints the board.",
			state: "todo",
			createdBy: "user",
		});
		const rpc = (selects: Array<string | undefined>, confirms: boolean[] = []) =>
			fakeCtx({ cwd: t.cwd, mode: "rpc", ui: { selects, confirms } });
		await t.command.handler("tui", rpc(["B1 [todo p2] first", "Move to…", "backlog", undefined]));
		expect(store.get("B1")!.state).toBe("backlog");
		await t.command.handler("tui", rpc(["B1 [backlog p2] first", "Priority…", "p0", undefined]));
		expect(store.get("B1")!.priority).toBe(0);
		await t.command.handler("tui", rpc(["+ Add an item", undefined]));
		await t.command.handler("B1", rpc(["Delegate to a subagent"]));
		expect(t.sent.at(-1)!.message).toContain("B1 [ongoing p0] first");
		expect(t.sent.at(-1)!.message).toContain("Done when: The selected action changes the item and repaints the board.");
		expect(store.get("B1")!.state).toBe("ongoing");
		// Every text field is editable, one editor per field; the editor shows the saved text and the change log records the edit.
		const edit = async (
			field: string | undefined,
			text: string | undefined,
		): Promise<{ shown?: string; title?: string }> => {
			const seen: { shown?: string; title?: string } = {};
			const edits = fakeCtx({ cwd: t.cwd, mode: "rpc", ui: { selects: ["Edit", field] } });
			Object.assign(edits.ui, {
				editor: async (title: string, shown: string) => Object.assign(seen, { title, shown }) && text,
			});
			await t.command.handler("B1", edits);
			return seen;
		};
		expect((await edit("Title", "  renamed\n title  ")).shown).toBe("first");
		expect(store.get("B1")!.title).toBe("renamed title");
		expect((await edit("Done when", "The goal reads true.")).shown).toBe(
			"The selected action changes the item and repaints the board.",
		);
		expect(store.get("B1")!.goal).toBe("The goal reads true.");
		await edit("Paths", "src/a.ts\n\nsrc/b.ts\nsrc/a.ts");
		await edit("Reason", "because");
		expect((await edit("Evidence", "src/a.ts:1 — shows it")).title).toBe("Edit the evidence of B1 (one per line)");
		await edit("Plan", "step one");
		expect(store.get("B1")).toMatchObject({
			paths: ["src/a.ts", "src/b.ts"],
			why: "because",
			evidence: ["src/a.ts:1 — shows it"],
			plan: "step one",
		});
		expect((await edit("Paths", undefined)).shown).toBe("src/a.ts\nsrc/b.ts");
		expect(store.get("B1")!.paths).toEqual(["src/a.ts", "src/b.ts"]);
		await edit("Plan", "");
		expect(store.get("B1")!.plan).toBe("");
		const log = store
			.notes(store.get("B1")!, 50)
			.map((note) => note.text)
			.join("\n");
		for (const part of [
			'title was "first"',
			'goal was "The selected action',
			"paths none → src/a.ts, src/b.ts",
			"why replaced; it was:",
			"evidence added",
			"plan added",
			"plan replaced; it was:\nstep one",
		])
			expect(log).toContain(part);
		// An empty title is refused and an unknown choice changes nothing.
		const before = store.get("B1")!;
		await edit("Title", "   ");
		await edit(undefined, "ignored");
		expect(store.get("B1")).toEqual(before);
		// Closing asks for a kind and a reason; cancelling either closes nothing, and the item is never deleted.
		await t.command.handler("B1", rpc(["Close", undefined]));
		expect(store.get("B1")!.closed).toBeUndefined();
		await t.command.handler(
			"B1",
			fakeCtx({ cwd: t.cwd, mode: "rpc", ui: { selects: ["Close", "obsolete"], inputs: ["no longer needed"] } }),
		);
		expect(store.get("B1")).toMatchObject({ state: "done", closed: { kind: "obsolete", text: "no longer needed" } });
	});

	it("rejects extra arguments before acting and completes the same item references that dispatch accepts", async () => {
		const t = setup();
		const store = workspaceStore(t.cwd);
		const before = store.add({ ...READY, title: "keep me", state: "todo", createdBy: "user" });
		const ctx = fakeCtx({ cwd: t.cwd, mode: "rpc", ui: { inputs: ["Completed", ""] } });
		const confirm = vi.spyOn(ctx.ui, "confirm");
		for (const args of ["do B1 extra", "export extra", "B1 done extra", "B1 close extra", "constructor", "__proto__"]) {
			await t.command.handler(args, ctx);
			expect(ctx.ui.notes.at(-1)?.type).toBe("warning");
			expect(store.get("B1")).toEqual(before);
		}
		expect(t.sent).toEqual([]);
		expect(confirm).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(t.cwd, ".octocode", "code", "backlog.md"))).toBe(false);
		expect(t.commands.complete("backlog #1 d")!.map((item) => item.value)).toEqual(["backlog #1 done"]);
		expect(t.commands.complete("backlog #1 c")!.map((item) => item.value)).toEqual(["backlog #1 close"]);
		await t.command.handler("#1 done", ctx);
		expect(store.get("B1")?.state).toBe("done");
		for (const syntax of ["add <title>", "do <id>", "export", "backlog|todo|ongoing|done|close"])
			expect(t.command.argumentHint).toContain(syntax);
	});

	it('shows the board, moves items with arrows, and "d" hands the selected item over', async () => {
		const t = setup();
		const store = workspaceStore(t.cwd);
		store.add({ ...READY, title: "alpha", state: "todo", createdBy: "user" });
		store.add({ ...READY, title: "beta", state: "backlog", createdBy: "user" });
		const frames: string[] = [];
		const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };
		const ctx = fakeCtx({
			cwd: t.cwd,
			ui: {
				custom: (factory) =>
					new Promise((resolve) => {
						const board = factory(tui, theme, new KeybindingsManager(), resolve);
						frames.push(rendered(board, 100));
						for (const key of [KEY.down, KEY.right]) {
							board.handleInput(key);
							frames.push(rendered(board, 100));
						}
						board.handleInput("d");
					}),
			},
		});
		await t.command.handler("tui", ctx);
		// Sections are drawn in flow order, so → (toward done) moves an item down the board.
		const at = (heading: string) => frames[0].indexOf(heading);
		expect(at("Backlog (triage) (1)")).toBeLessThan(at("Todo (1)"));
		expect(at("Todo (1)")).toBeLessThan(at("Ongoing (0)"));
		expect(at("Ongoing (0)")).toBeLessThan(at("Done (0)"));
		expect(frames[0]).toMatch(/› [▶☐⧗] B2 p2 beta/);
		expect(frames[1]).toMatch(/› [▶☐⧗] B1 p2 alpha/);
		// → moves alpha from todo to ongoing; ← would move it back.
		expect(frames[2]).toContain("Ongoing (1)");
		expect(frames[2]).toMatch(/› [▶☐⧗] B1 p2 alpha/);
		expect(frames[2]).toContain("left/right move state");
		expect(store.get("B1")).toMatchObject({ state: "ongoing", assignee: "session-test" });
		expect(t.sent.at(-1)!.message).toMatch(/^Implement backlog item B1\n/);
		expect(t.sent.at(-1)!.message).toContain("B1 [ongoing p2] alpha");
	});

	it("orders board rows by state and keeps only the latest done items", async () => {
		const store = storeFor("r");
		for (let index = 0; index < 7; index++)
			store.add({ ...READY, title: `d${index}`, state: "done", completion: completed(), createdBy: "user" });
		store.add({ ...READY, title: "now", state: "ongoing", createdBy: "user" });
		const rows = boardRows(store.list().items);
		expect(rows[0].title).toBe("now");
		expect(rows).toHaveLength(6);
		const ctx = fakeCtx({
			cwd: tmp,
			ui: {
				custom: (factory) =>
					new Promise((resolve) =>
						factory(
							{ requestRender: () => undefined, terminal: { rows: 40 } },
							theme,
							new KeybindingsManager(),
							resolve,
						).handleInput(KEY.escape),
					),
			},
		});
		expect(
			await showBoard(ctx, { title: "x", self: "s", load: () => store.list().items, move: () => undefined }),
		).toBeUndefined();
	});
});

describe("backlog fields: where, why, evidence, plan", () => {
	const FIELDS = {
		goal: "Search finds an item by path; focused tests pass.",
		paths: ["src/backlog/store.ts", "src/backlog/"],
		why: "Agents lose the reason behind an item after a resume.",
		evidence: ["src/backlog/store.ts:87 — body copied into notes", "yarn test → 2 failures"],
		plan: "Add four columns, then render them.\nKeep search on LIKE.",
	};

	it("stores each field with entries cleaned to single lines, and finds an item by a path substring or an evidence word", () => {
		const store = storeFor("r");
		const item = store.add({
			title: "search",
			...FIELDS,
			paths: ["  src/backlog/store.ts ", "src/backlog/store.ts", "", "docs/\nA.md"],
			createdBy: "user",
		});
		expect(item).toMatchObject({
			paths: ["src/backlog/store.ts", "docs/ A.md"],
			why: FIELDS.why,
			evidence: FIELDS.evidence,
			plan: FIELDS.plan,
		});
		store.add({ title: "unrelated", createdBy: "user" });
		expect(store.get("B2")).toMatchObject({ paths: [], why: "", evidence: [], plan: "" });
		const found = (query: string) => store.list({ query }).items.map((each) => each.ref);
		expect(found("backlog/store")).toEqual(["B1"]);
		expect(found("2 failures")).toEqual(["B1"]);
		expect(found("after a resume")).toEqual(["B1"]);
		expect(found("four columns")).toEqual(["B1"]);
		expect(found("100%")).toEqual([]);
	});

	it("logs every changed field with the old value in full, and nothing when a field is set to what it was", () => {
		const store = storeFor("r");
		const item = store.add({ title: "fields", ...FIELDS, state: "todo", createdBy: "user" });
		store.update(item.ref, { paths: ["src/a.ts"], why: "new why", evidence: ["one"], plan: "new plan" }, { id: "s1" });
		store.update(item.ref, { paths: ["src/a.ts"], why: "new why", evidence: ["one"], plan: "new plan" }, { id: "s1" });
		const blank = store.add({ title: "blank", createdBy: "user" });
		store.update(blank.ref, { why: "w", evidence: ["e"], plan: "p", paths: ["x"] }, { id: "s1" });
		const [first, ...more] = store.notes(item, 50);
		expect(more).toEqual([]);
		expect(first.text).toBe(
			`paths src/backlog/store.ts, src/backlog/ → src/a.ts · why replaced; it was:\n${FIELDS.why} · evidence replaced; it was:\n${FIELDS.evidence.join("\n")} · plan replaced; it was:\n${FIELDS.plan}`,
		);
		expect(store.notes(blank)[0].text).toBe("paths none → x · why added · evidence added · plan added");
		expect(store.update(item.ref, { paths: [] }, { id: "s1" }).paths).toEqual([]);
	});

	it("refuses a secret in any new field", () => {
		const store = storeFor("r");
		for (const field of ["why", "plan"])
			expect(() => store.add({ title: "t", [field]: `use ${SECRET}`, createdBy: "user" })).toThrow(
				new RegExp(`${field} .*secret`),
			);
		expect(() => store.add({ title: "t", evidence: ["fine", SECRET], createdBy: "user" })).toThrow(/evidence .*secret/);
		const item = store.add({ title: "t", createdBy: "user" });
		expect(() => store.update(item.ref, { paths: [SECRET] }, { id: "s1" })).toThrow(/paths .*secret/);
	});

	it("adds with every field through the tool; get shows Done when, Where, Why, Evidence, Plan, then times and notes; list stays one line", async () => {
		const t = setup();
		expect(await t.text({ op: "add", items: [{ title: "Path search", ...FIELDS, state: "todo" }] })).toBe(
			"Added B1 [todo p2] Path search",
		);
		await t.text({ op: "note", id: "B1", note: "looked at it" });
		const detail = await t.text({ op: "get", id: "B1" });
		const order = [
			"Done when: Search finds",
			"Where: src/backlog/store.ts, src/backlog/",
			"Why: Agents lose",
			"Evidence:\n- src/backlog/store.ts:87 — body copied into notes\n- yarn test → 2 failures",
			"Plan: Add four columns, then render them.\n  Keep search on LIKE.",
			"created ",
			"Notes:",
		];
		const at = order.map((part) => detail.indexOf(part));
		expect(at.every((index) => index >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		expect(await t.text({ op: "list" })).toBe("B1 [todo p2] Path search");
		expect(await t.text({ op: "list", query: "src/backlog/" })).toBe("B1 [todo p2] Path search");
		expect(await t.text({ op: "edit", items: [{ id: "B1", paths: ["src/x.ts"], plan: "Replace it." }] })).toMatch(
			/^Updated B1 \[todo p2\] v\d+$/,
		);
		expect(await t.text({ op: "get", id: "B1" })).toContain("Where: src/x.ts\n");
		expect(await t.text({ op: "get", id: "B1" })).toContain("Plan: Replace it.\n");
	});

	it("omits the sections an item leaves empty", async () => {
		const t = setup();
		await t.text({ op: "add", items: [{ title: "Plain", goal: "It works.", why: "Because." }] });
		const detail = await t.text({ op: "get", id: "B1" });
		expect(detail).toContain("Done when: It works.");
		expect(detail).toContain("Why: Because.");
		for (const heading of ["Where:", "Evidence:", "Plan:"]) expect(detail).not.toContain(heading);
	});

	it("requires a goal when an agent adds, before anything is stored, but not when the user adds", async () => {
		const t = setup();
		await expect(t.call({ op: "add", items: [{ why: "Required work", title: "no goal" }] })).rejects.toThrow(
			/add needs a goal/,
		);
		await expect(
			t.call({ op: "add", items: [{ why: "Required work", title: "blank goal", goal: "  " }] }),
		).rejects.toThrow(/add needs a goal/);
		expect(workspaceStore(t.cwd).list({ states: ["backlog"] }).total).toBe(0);
		await t.command.handler("add by the user", fakeCtx({ cwd: t.cwd, hasUI: false }));
		expect(workspaceStore(t.cwd).get("B1")).toMatchObject({ title: "by the user", goal: "" });
	});

	it("does not let an agent clear a goal by edit, and still lets it change one", async () => {
		const t = setup();
		await t.text({ op: "add", items: [{ why: "Required work", title: "Item", goal: "Tests pass." }] });
		for (const goal of ["", " \n "])
			await expect(t.call({ op: "edit", items: [{ id: "B1", goal }] })).rejects.toThrow(/edit cannot clear the goal/);
		expect(workspaceStore(t.cwd).get("B1")).toMatchObject({ goal: "Tests pass." });
		await t.text({ op: "edit", items: [{ id: "B1", goal: "Tests and lint pass." }] });
		expect(workspaceStore(t.cwd).get("B1")).toMatchObject({ goal: "Tests and lint pass." });
	});

	it("offers typed paths and evidence fields without a body field", () => {
		const properties = planEntryFields(setup().plan);
		expect(properties).not.toHaveProperty("body");
		expect(properties.paths.type).toBe("array");
		expect(properties.evidence.type).toBe("array");
	});

	it("lets a subagent propose with every field, but update only state and notes", async () => {
		const parent = setup();
		await parent.text({
			op: "add",
			items: [{ why: "Required work", title: "delegated", goal: "Done.", state: "todo" }],
		});
		workspaceStore(parent.cwd).update("B1", { state: "ongoing" }, { id: "parent-session" });
		const sub = setup({ isSubagent: true, agentId: "general-1", parentSession: "parent-session" });
		// The child's own tool has no descriptive field; `backlogPlan`, which it registers without declaring, has them.
		expect(Object.keys(sub.tool.parameters.properties)).toEqual(
			expect.not.arrayContaining(["paths", "evidence", "plan"]),
		);
		expect(Object.keys(planEntryFields(sub.plan))).toEqual(
			expect.arrayContaining(["paths", "why", "evidence", "plan"]),
		);
		await sub.text({ op: "add", items: [{ title: "found", ...FIELDS, from: "B1" }] });
		expect(workspaceStore(sub.cwd).get("B2")).toMatchObject({
			paths: FIELDS.paths,
			evidence: FIELDS.evidence,
			why: FIELDS.why,
			plan: FIELDS.plan,
		});
		await expect(sub.call({ op: "add", items: [{ title: "no goal", why: "x" }] })).rejects.toThrow(/add needs a goal/);
		for (const change of [{ paths: ["x"] }, { why: "x" }, { evidence: ["x"] }, { plan: "x" }]) {
			await expect(sub.call({ op: "edit", items: [{ id: "B1", ...change }] })).rejects.toThrow(
				/only the state and notes/,
			);
		}
	});

	it('hands every saved field to the agent with "do"', async () => {
		const t = setup();
		workspaceStore(t.cwd).add({
			title: "Fix search",
			...FIELDS,
			state: "todo",
			createdBy: "user",
		});
		await t.command.handler("do B1", fakeCtx({ cwd: t.cwd, hasUI: false }));
		const message = t.sent.at(-1)!.message;
		expect(message).toContain("Where: src/backlog/store.ts, src/backlog/");
		expect(message).toContain("Why: Agents lose");
		expect(message).toContain("- yarn test → 2 failures");
		expect(message).toContain("Plan: Add four columns");
	});

	it("shows the fields in /backlog <id> and in the markdown export", async () => {
		const t = setup();
		workspaceStore(t.cwd).add({
			title: "Fix search",
			...FIELDS,
			state: "todo",
			createdBy: "user",
		});
		const ctx = fakeCtx({ cwd: t.cwd, hasUI: false });
		await t.command.handler("B1", ctx);
		const shown = ctx.ui.notes.at(-1)!.message;
		expect(shown).toMatch(
			/Done when: .*\nWhere: src\/backlog\/store\.ts, src\/backlog\/\nWhy: .*\nEvidence:\n- .*\n- .*\nPlan: /,
		);
		await t.command.handler("export", ctx);
		const markdown = fs.readFileSync(path.join(t.cwd, ".octocode", "code", "backlog.md"), "utf8");
		expect(markdown).toContain(
			"  Where: src/backlog/store.ts, src/backlog/\n  Why: Agents lose the reason behind an item after a resume.\n  Evidence:\n  - src/backlog/store.ts:87",
		);
		expect(markdown).toContain("  Plan: Add four columns, then render them.\n    Keep search on LIKE.");
	});
});
