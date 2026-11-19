import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { boardLayout } from "../../src/octocode/backlog/board-model.ts";
import { boardText, countsText } from "../../src/octocode/backlog/format.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { applyBacklogCommand } from "../../src/octocode/backlog/web-commands.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-close-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const tool = fake.tools.get("backlog");
	const text = async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute("id", params, undefined, undefined, fakeCtx({ cwd }))) as { content: Array<{ text: string }> }
		).content[0].text;
	for (const title of ["first", "second", "third"])
		await text({ op: "add", items: [{ title, goal: `${title} done`, why: `${title} needed`, state: "todo" }] });
	const agent = sharedAgentDb();
	const store = new BacklogStore(() => agent, registeredWorkspace(cwd, agent).id);
	return { text, tool, plan: fake.tools.get("backlogPlan"), store };
}

describe("closing a backlog item", () => {
	it("needs a kind and a reason, and a duplicate names another item", async () => {
		const { text } = await setup();
		await expect(text({ op: "close", id: "B1", close: { kind: "obsolete", text: " " } })).rejects.toThrow(
			/needs a reason/,
		);
		await expect(text({ op: "close", id: "B1", close: { kind: "duplicate", text: "same" } })).rejects.toThrow(
			/names the item/,
		);
		await expect(text({ op: "close", id: "B1", close: { kind: "duplicate", text: "same", of: "B1" } })).rejects.toThrow(
			/itself/,
		);
		expect(await text({ op: "close", id: "B1", close: { kind: "duplicate", text: "same work", of: "B2" } })).toMatch(
			/^Updated B1/,
		);
	});

	it("hides closed items by default, lists them with states closed, and reopens with a note", async () => {
		const { text } = await setup();
		await text({ op: "close", id: "B1", close: { kind: "obsolete", text: "no longer needed" } });
		expect(await text({ op: "list" })).not.toContain("first");
		expect(await text({ op: "list", states: ["closed"] })).toContain("first");
		await expect(text({ op: "edit", items: [{ id: "B1", state: "todo" }] })).rejects.toThrow(/Reopening needs a note/);
		await expect(text({ op: "done", id: "B1" })).rejects.toThrow(/closed/);
		await text({ op: "edit", items: [{ id: "B1", state: "todo", note: "needed after all" }] });
		expect(await text({ op: "list" })).toContain("first");
		expect(await text({ op: "list", states: ["closed"] })).not.toContain("first");
	});

	it("keeps no delete op: remove is not a tool operation and the store has no remove", async () => {
		const { tool, plan, store } = await setup();
		const ops = (declared: unknown) => (declared as { properties: { op: { enum: string[] } } }).properties.op.enum;
		expect(ops(tool.parameters)).toEqual(["get", "claim", "note", "done", "close", "step"]);
		expect(ops(plan.parameters)).toEqual(["add", "edit", "list"]);
		expect((store as unknown as Record<string, unknown>).remove).toBeUndefined();
	});

	it("audits each change type with the actor and the surface, and shows the trail in get", async () => {
		const { text, store } = await setup();
		await text({ op: "note", id: "B1", note: "a note" });
		await text({ op: "edit", items: [{ id: "B1", title: "renamed", links: [{ relation: "related", target: "B2" }] }] });
		await text({ op: "close", id: "B1", close: { kind: "wont_do", text: "not doing it" } });
		await text({ op: "edit", items: [{ id: "B1", state: "todo", note: "back" }] });
		const events = store.audit("B1");
		const has = (entity: string, action: string) => events.some((e) => e.entity === entity && e.action === action);
		expect(has("backlog", "insert")).toBe(true);
		expect(has("backlog", "update")).toBe(true);
		expect(has("backlog_comments", "insert")).toBe(true);
		expect(has("backlog_links", "insert")).toBe(true);
		const closedRow = events.find((e) => (e.after as { closed?: string } | null)?.closed);
		expect(closedRow?.actor).toMatchObject({ kind: "agent", surface: "tool" });
		expect(JSON.parse((closedRow!.after as { closed: string }).closed)).toMatchObject({ kind: "wont_do" });
		expect(await text({ op: "get", id: "B1" })).not.toMatch(/Audit \(latest/);
		const trail = await text({ op: "get", id: "B1", changes: true });
		expect(trail).toMatch(/Audit \(latest/);
		expect(trail).toMatch(/\(agent via tool\)/);
		expect(trail).toMatch(/closed/);
	});

	it("audits a close from the web command as the user", async () => {
		const { store } = await setup();
		const before = store.get("B2")!;
		const { item } = applyBacklogCommand(
			store,
			{ command: "item.close", id: "B2", version: before.version, kind: "obsolete", text: "superseded by plan" },
			"session",
		);
		expect(item?.closed).toMatchObject({ kind: "obsolete", text: "superseded by plan", by: "user" });
		const row = store.audit("B2").find((e) => (e.after as { closed?: string } | null)?.closed);
		expect(row?.actor).toMatchObject({ id: "user", kind: "human", surface: "web" });
	});

	it("lets a subagent close only its parent's claimed item, like done", async () => {
		const { store } = await setup();
		store.update("B3", { state: "ongoing" }, { id: "parent-session" });
		const child = { id: "child", owners: new Set(["parent-session"]), item: "B3", surface: "tool" as const };
		expect(() => store.update("B1", { close: { kind: "obsolete", text: "x" } }, child)).toThrow(
			/not claimed by your coordinator/,
		);
		expect(store.update("B3", { close: { kind: "obsolete", text: "obsolete" } }, child).closed?.by).toBe("child");
	});
});

describe("closed is not done", () => {
	const completion = {
		summary: "shipped",
		files: [],
		verification: { status: "passed", summary: "tests pass" },
	};

	it("lists done and closed apart", async () => {
		const { text } = await setup();
		await text({ op: "close", id: "B1", close: { kind: "obsolete", text: "gone" } });
		await text({ op: "claim", id: "B2" });
		await text({ op: "done", id: "B2", completion, note: "ok" });
		const only = (state: string) => text({ op: "list", states: [state] });
		expect(await only("done")).toContain("second");
		expect(await only("done")).not.toContain("first");
		expect(await only("closed")).toContain("first");
		expect(await only("closed")).not.toContain("second");
		const both = await text({ op: "list", states: ["done", "closed"] });
		expect(both).toContain("first");
		expect(both).toContain("second");
	});

	it("counts closed apart from done, and the board and headless text hide it", async () => {
		const { text, store } = await setup();
		await text({ op: "close", id: "B1", close: { kind: "wont_do", text: "no" } });
		await text({ op: "claim", id: "B2" });
		await text({ op: "done", id: "B2", completion, note: "ok" });
		const counts = store.counts();
		expect(counts.items).toMatchObject({ todo: 1, done: 1 });
		expect(counts.closed).toBe(1);
		// Closed items only ever grow: the footer leaves them to `/backlog`.
		expect(countsText(counts)).not.toContain("closed");
		const layout = boardLayout({ items: store.list().items, tasks: [], session: "s" });
		expect(layout.counts.closed).toBe(1);
		expect(layout.rows.map((row) => row.key)).not.toContain("B1");
		expect(layout.rows.map((row) => row.key)).toContain("B2");
		const headless = boardText(store);
		expect(headless).not.toContain("first");
		expect(headless).toContain("Closed (1, hidden)");
	});

	it("resolves a prerequisite and an epic like done", async () => {
		const { text, store } = await setup();
		store.update("B2", { dependsOn: ["B1"] }, { id: "agent" });
		expect(store.marks(store.list().items, "s").get("B2")?.blockedBy).toEqual(["B1"]);
		await text({ op: "close", id: "B1", close: { kind: "obsolete", text: "gone" } });
		expect(store.marks(store.list().items, "s").get("B2")?.blockedBy).toBeUndefined();
		await text({ op: "add", items: [{ type: "epic", title: "epic", goal: "all done", why: "group" }] });
		store.update("B1", { parentId: "B4" }, { id: "agent" });
		expect(store.epicState(store.get("B4")!)).toBe("done");
	});
});
