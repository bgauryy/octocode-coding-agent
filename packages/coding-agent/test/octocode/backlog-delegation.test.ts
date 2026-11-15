import { backlogToolName, fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { delegatePrompt, doItPrompt } from "../../src/octocode/backlog/actions.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { attachReport, heldItem } from "../../src/octocode/backlog/delegation.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogError, type BacklogStore, COMPLETION_GUIDANCE } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const READY = { goal: "Expected result", why: "Required work" };
const completed = (status: "passed" | "not_applicable" = "passed") => ({
	summary: "Implemented",
	files: [],
	verification: { status, summary: "Focused check passed" },
	operationKey: crypto.randomUUID(),
});

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-link-")));
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

/** Record a session row, as the sessions feature does at session_start. */
function session(id: string, pid: number | null, db: AgentDb = sharedAgentDb()): void {
	db.db.prepare(`INSERT INTO sessions (id, pid) VALUES (?, ?)`).run(id, pid);
}

function setup(options: { isSubagent?: boolean; agentId?: string; parentSession?: string; item?: string } = {}) {
	const fake = fakeHost();
	const commands = new Subcommands();
	// The tests may run inside an Octocode subagent: only the options name a parent or an item.
	const env = { ...process.env };
	delete env[PARENT_SESSION_ENV];
	delete env[BACKLOG_ITEM_ENV];
	if (options.parentSession) env[PARENT_SESSION_ENV] = options.parentSession;
	if (options.item) env[BACKLOG_ITEM_ENV] = options.item;
	registerBacklog(fake.api, {
		commands,
		isSubagent: options.isSubagent ?? false,
		...(options.agentId ? { agentId: () => options.agentId } : {}),
		env,
	});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const tool = fake.tools.get("backlog");
	const call = (params: Record<string, unknown>) =>
		fake.tools
			.get(backlogToolName(params.op))
			.execute("id", params, undefined, undefined, fakeCtx({ cwd })) as Promise<{
			content: Array<{ text: string }>;
		}>;
	const text = async (params: Record<string, unknown>) => (await call(params)).content[0].text;
	return { ...fake, cwd, tool, call, text };
}

describe("write rules live in the store", () => {
	it("limits an item-bound subagent to its item, and lets it propose follow-ups", () => {
		const store = storeFor("r");
		const mine = store.add({ ...READY, title: "mine", state: "todo", createdBy: "user" });
		const other = store.add({ ...READY, title: "other", state: "todo", createdBy: "user" });
		store.update(mine.ref, { state: "ongoing" }, { id: "parent" });
		store.update(other.ref, { state: "ongoing" }, { id: "parent" });
		const bound = { id: "sub-1", owners: new Set(["parent"]), item: "b1" };
		expect(() => store.update(other.ref, { note: "hi" }, bound)).toThrow(/B2 is not your item: .*B1/);
		expect(store.update(mine.ref, { note: "progress" }, bound).version).toBe(mine.version + 2);
		expect(store.add({ ...READY, title: "follow-up", from: "B1", createdBy: "agent:sub-1" }, bound).state).toBe(
			"backlog",
		);
		// An unbound child of the same parent still reaches both items.
		const free = { id: "sub-2", owners: new Set(["parent"]) };
		expect(store.update(other.ref, { note: "also" }, free).ref).toBe("B2");
	});

	it("applies the subagent proposal and removal rules in the store, not only in the tool", () => {
		const store = storeFor("r");
		const sub = { id: "sub-1", owners: new Set(["parent"]) };
		expect(() => store.add({ ...READY, title: "x", parentId: "B1", createdBy: "agent:sub-1" }, sub)).toThrow(
			/A subagent proposal cannot set parentId/,
		);
		expect(() => store.add({ ...READY, title: "x", note: "n", createdBy: "agent:sub-1" }, sub)).toThrow(
			/A subagent adds without a note/,
		);
		// A proposal lands in backlog whatever state the child asked for.
		expect(store.add({ ...READY, title: "x", state: "todo", createdBy: "agent:sub-1" }, sub).state).toBe("backlog");
		expect(store.get("B1")).toBeDefined();
	});

	it("enforces completion and declares its schema and activation", async () => {
		expect(COMPLETION_GUIDANCE).toMatch(/needs completion/);
		const store = storeFor("r");
		store.add({ ...READY, title: "task", state: "todo", createdBy: "user" });
		expect(() => store.update("B1", { state: "done" }, { id: "s" })).toThrow(COMPLETION_GUIDANCE);
		expect(() => store.add({ ...READY, title: "shipped", state: "done", createdBy: "user" })).toThrow(
			COMPLETION_GUIDANCE,
		);
		const t = setup();
		expect(t.tool.parameters.properties.op.enum).toContain("done");
		expect(t.tool.parameters.properties.completion.required).toEqual(["summary", "verification"]);
		const child = setup({ isSubagent: true, parentSession: "p" }).tool;
		// Registered either way, declared to the model only when the task names an item.
		expect(child.defaultActive).toBe(false);
		expect(setup({ isSubagent: true, parentSession: "p", item: "B1" }).tool.defaultActive).toBe(true);
		expect(setup().tool.defaultActive).toBe(true);
		const item = store.get("B1")!;
		expect(doItPrompt(item, store)).toContain(COMPLETION_GUIDANCE);
		expect(delegatePrompt(item, store)).toContain(COMPLETION_GUIDANCE);
		// The tool's own error (its store is the cwd repository's) is the same text.
		await t.text({ op: "add", items: [{ ...READY, title: "tool task", state: "todo" }] });
		await expect(t.call({ op: "done", id: "B1" })).rejects.toThrow(COMPLETION_GUIDANCE);
	});

	it("refuses a subagent whose parent session is unknown, naming the missing owner", async () => {
		const orphan = setup({ isSubagent: true, agentId: "general-1" });
		await expect(orphan.call({ op: "list" })).rejects.toThrow(
			new RegExp(`parent session is unknown \\(${PARENT_SESSION_ENV} is unset\\)`),
		);
	});

	it("binds the tool's actor to the item named in the environment", async () => {
		const parent = setup();
		await parent.text({ op: "add", items: [{ ...READY, title: "one", state: "todo" }] });
		await parent.text({ op: "add", items: [{ ...READY, title: "two", state: "todo" }] });
		const store = openBacklog(fakeCtx({ cwd: parent.cwd }), { isSubagent: false }).store;
		store.update("B1", { state: "ongoing" }, { id: "parent-session" });
		store.update("B2", { state: "ongoing" }, { id: "parent-session" });
		const sub = setup({ isSubagent: true, agentId: "general-1", parentSession: "parent-session", item: "B2" });
		await expect(sub.call({ op: "note", id: "B1", note: "x" })).rejects.toThrow(/B1 is not your item/);
		expect(await sub.text({ op: "note", id: "B2", note: "x" })).toBe("Updated B2 [ongoing p2] two (coordinator)");
	});
});

describe("the item a parent hands to a child", () => {
	function backlog(sessionId = "session-test") {
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd });
		ctx.sessionManager.getSessionId = () => sessionId;
		return openBacklog(ctx, { isSubagent: false });
	}

	it("must be held by this session: ongoing and assigned to it", () => {
		const b = backlog();
		const store = b.store;
		store.add({ ...READY, title: "todo", state: "todo", createdBy: "user" });
		store.add({ ...READY, title: "theirs", state: "todo", createdBy: "user" });
		store.add({ ...READY, title: "held", state: "todo", createdBy: "user" });
		session("other", process.ppid);
		store.update("B2", { state: "ongoing" }, { id: "other" });
		store.update("B3", { state: "ongoing" }, { id: "session-test" });
		expect(() => heldItem(b, "B9")).toThrow(/No backlog item B9/);
		expect(() => heldItem(b, "nope")).toThrow(/No backlog item nope/);
		expect(() => heldItem(b, "B1")).toThrow(/B1 is todo, not held by this session: claim it \(ongoing\) first/);
		expect(() => heldItem(b, "B2")).toThrow(/B2 is held by other, not by this session/);
		expect(heldItem(b, "b3").ref).toBe("B3");
	});

	it("notes the child's report on it: outcome, saved path and agent", () => {
		const b = backlog();
		b.store.add({ ...READY, title: "held", state: "todo", createdBy: "user" });
		b.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		attachReport(b, "B1", {
			agent: "inky-kraken",
			outcome: "partial",
			file: "/repo/.octocode/code/temp/agents/x/report.md",
		});
		attachReport(b, "B1", { agent: "inky-kraken", outcome: undefined, checks: ["yarn test"] });
		const notes = b.store.notes(b.store.get("B1")!, -1).filter((note) => note.kind === "note");
		expect(notes.map((note) => note.text)).toEqual([
			"Report from inky-kraken: partial. Saved at /repo/.octocode/code/temp/agents/x/report.md.",
			"Report from inky-kraken: no outcome word.",
		]);
		expect(notes.every((note) => note.author === "session-test")).toBe(true);
	});

	it("records the named checks as completion evidence when done and the completion passed", () => {
		const b = backlog();
		b.store.add({ ...READY, title: "held", state: "todo", createdBy: "user" });
		b.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const child = { id: "inky-kraken", owners: new Set(["session-test"]) };
		// Done reported, but the child never closed the item: no evidence, and the note says so.
		attachReport(b, "B1", { agent: "inky-kraken", outcome: "done", checks: ["yarn test"] });
		b.store.update("B1", { state: "done", completion: completed() }, child);
		attachReport(b, "B1", { agent: "inky-kraken", outcome: "done", checks: ["yarn test: 3 passed", "tsc"] });
		attachReport(b, "B1", { agent: "inky-kraken", outcome: "done" });
		const notes = b.store.notes(b.store.get("B1")!, -1).filter((note) => note.kind === "note");
		expect(notes.map((note) => note.text)).toEqual([
			"Report from inky-kraken: done. B1 is ongoing without a passed completion.",
			"Report from inky-kraken: done. Completion evidence, the checks its report names: yarn test: 3 passed; tsc.",
			"Report from inky-kraken: done. Completion evidence: no checks named.",
		]);
	});

	it("takes no evidence from a completion that was not run", () => {
		const b = backlog();
		b.store.add({ ...READY, title: "held", state: "todo", createdBy: "user" });
		b.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		b.store.update("B1", { state: "done", completion: completed("not_applicable") }, { id: "session-test" });
		attachReport(b, "B1", { agent: "inky-kraken", outcome: "done", checks: ["yarn test"] });
		const notes = b.store.notes(b.store.get("B1")!, -1).filter((note) => note.kind === "note");
		expect(notes.at(-1)!.text).toBe("Report from inky-kraken: done. B1 is done without a passed completion.");
	});

	it("refuses to note a removed item", () => {
		const b = backlog();
		expect(() => attachReport(b, "B1", { agent: "x", outcome: "done" })).toThrow(BacklogError);
	});
});
