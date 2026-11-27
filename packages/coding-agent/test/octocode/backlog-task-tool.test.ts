import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { Value } from "typebox/value";

const SESSION = "session-test";
const READY = { goal: "Result can be checked", why: "Users need it" };
const completed = () => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed" as const, summary: "Focused check passed" },
	operationKey: crypto.randomUUID(),
});

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-task-tool-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * The backlog tools of one session, and `step`, which adds a step as the user does on the board (tools finish existing steps):
 * a subagent when `env` names its parent, in the repository `repo`.
 */
function setup(options: { subagent?: { id: string; env: Record<string, string> } } = {}) {
	const fake = fakeHost();
	registerBacklog(fake.api, {
		commands: new Subcommands(),
		isSubagent: options.subagent !== undefined,
		...(options.subagent
			? { agentId: () => options.subagent!.id, env: { ...process.env, ...options.subagent.env } }
			: {}),
	});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const caller = (name?: string) => async (params: Record<string, unknown>) =>
		(
			(await fake.tools.get(name ?? backlogToolName(params.op)).execute("id", params, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	return {
		...fake,
		ctx,
		backlog: caller(),
		step: (goal: string, item?: string) =>
			storeOfRepo().tasks.add({ goal, ...(item ? { item } : { session: SESSION }) }, { id: SESSION }),
		store: storeOfRepo,
	};
}

/** The store of the repository the tools open: the same key `openBacklog` computes. */
function storeOfRepo(): BacklogStore {
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	return new BacklogStore(() => workspaceDb(cwd).agent, workspaceDb(cwd).workspace.id);
}

describe("backlog tools over stored steps", () => {
	it("registers no steps tool, and get still shows an item's stored steps", async () => {
		const t = setup();
		expect(t.tools.has("steps")).toBe(false);
		expect(t.tools.get("backlog").defaultActive).toBe(true);
		await t.backlog({ op: "add", items: [{ title: "Work", state: "ongoing", ...READY }] });
		t.step("Under B1", "B1");
		t.step("Of the session");
		expect(await t.backlog({ op: "get", id: "B1" })).toContain("Steps (1):\n- T1 [todo] Under B1");
	});

	it("shows the tree: type, parent, blocked-by, open steps, stale claims and an epic's items", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ title: "Group", type: "epic", ...READY }] });
		await t.backlog({ op: "add", items: [{ title: "Prereq", parentId: "B1", type: "bug", ...READY }] });
		await t.backlog({
			op: "add",
			items: [{ title: "Waits", parentId: "B1", dependsOn: ["B2"], state: "todo", ...READY }],
		});
		await t.backlog({ op: "add", items: [{ title: "Mine", state: "ongoing", ...READY }] });
		t.store().update("B2", { state: "ongoing" }, { id: "gone-session" });
		t.step("Draft", "B3");
		const all = await t.backlog({ op: "list", states: ["backlog", "todo", "ongoing", "done"] });
		expect(all).toContain("B2 [ongoing p2 bug] Prereq ⊂B1 (@gone-session) (stale: holder ended)");
		expect(all).toContain("B3 [todo p2] Waits ⊂B1 (blocked by B2) (1 open step)");
		expect(all).toContain("B1 [backlog p2 epic] Group");
		// An item the reader holds carries no stale mark.
		expect(all).toContain("B4 [ongoing p2] Mine (you)");
		const epic = await t.backlog({ op: "get", id: "B1" });
		expect(epic).toContain("Items (0/2 done):");
		expect(epic).toContain("- B2 [ongoing p2 bug] Prereq (@gone-session) (stale: holder ended)");
		expect(epic).toContain("- B3 [todo p2] Waits (blocked by B2) (1 open step)");
		expect(await t.backlog({ op: "get", id: "B3" })).toMatch(
			/^B3 \[todo p2\] Waits ⊂B1 \(blocked by B2\) \(1 open step\)/,
		);
		expect(await t.backlog({ op: "get", id: "B4" })).not.toContain("Items (");
	});

	it("lets a done item be reopened, flags the done items that waited on it and names them", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ title: "Group", type: "epic", ...READY }] });
		await t.backlog({ op: "add", items: [{ title: "Child", parentId: "B1", state: "ongoing", ...READY }] });
		await t.backlog({ op: "done", id: "B2", completion: completed() });
		await t.backlog({ op: "done", id: "B1", completion: completed() });
		await t.backlog({ op: "add", items: [{ title: "Base", state: "ongoing", ...READY }] });
		await t.backlog({ op: "done", id: "B3", completion: completed() });
		await t.backlog({ op: "add", items: [{ title: "Built on base", dependsOn: ["B3"], state: "ongoing", ...READY }] });
		await t.backlog({ op: "done", id: "B4", completion: completed() });
		expect(await t.backlog({ op: "edit", items: [{ id: "B2", state: "todo", note: "Regression" }] })).toContain(
			"\nNeeds review (done): B1 (parent of B2).",
		);
		expect(await t.backlog({ op: "edit", items: [{ id: "B3", state: "todo", note: "Regression" }] })).toContain(
			"\nNeeds review (done): B4 (depends on B3).",
		);
		const done = await t.backlog({ op: "list", states: ["done"] });
		expect(done).toContain("B1 [done p2 epic] Group (needs review: B2 open)");
		expect(done).toContain("B4 [done p2] Built on base (needs review: B3 open)");
		// Reopening something nothing waited on says nothing.
		await t.backlog({ op: "add", items: [{ title: "Alone", state: "ongoing", ...READY }] });
		await t.backlog({ op: "done", id: "B5", completion: completed() });
		expect(await t.backlog({ op: "edit", items: [{ id: "B5", state: "todo", note: "Again" }] })).not.toContain(
			"Needs review",
		);
	});

	it("refuses to move an epic with items between states, but lets it close and reopen", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ title: "Group", type: "epic", ...READY }] });
		// No items yet: the stored state is the epic's own.
		expect(await t.backlog({ op: "claim", id: "B1" })).toContain("[ongoing");
		await t.backlog({ op: "add", items: [{ title: "Child", parentId: "B1", state: "ongoing", ...READY }] });
		for (const state of ["backlog", "todo"])
			await expect(t.backlog({ op: "edit", items: [{ id: "B1", state }] })).rejects.toThrow(
				/^B1 is an epic with items: its state follows them \(1 of its 1 items are not done\) \(open: B2\)\./,
			);
		await t.backlog({ op: "done", id: "B2", completion: completed() });
		await t.backlog({ op: "done", id: "B1", completion: completed() });
		expect(await t.backlog({ op: "edit", items: [{ id: "B1", state: "todo", note: "More to do" }] })).toContain(
			"[todo",
		);
	});

	it("refuses to finish an item with open steps, naming them and where they end, and finishes it once they end", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ title: "Work", state: "ongoing", ...READY }] });
		t.step("Step one", "B1");
		t.step("Step two", "B1");
		await expect(t.backlog({ op: "done", id: "B1", completion: completed() })).rejects.toThrow(
			/^B1 has open tasks: T1, T2: finish completed steps with backlog step \(id T…, note: result and checks\); the user drops unneeded steps on the backlog board \(\/backlog\)\./,
		);
		t.store().tasks.update("T1", { state: "done" }, { id: SESSION });
		t.store().tasks.update("T2", { state: "dropped", result: "not needed" }, { id: SESSION });
		await expect(t.backlog({ op: "done", id: "B1", completion: completed() })).resolves.toContain("[done");
	});

	it("refuses the former item type task like any unknown type", async () => {
		const t = setup();
		const backlogTool = t.tools.get("backlogPlan");
		expect(JSON.stringify(backlogTool.parameters)).not.toContain('"task"');
		// The declaration names the item types; a call is checked entry by entry when it runs, so the refusal is in words.
		const declared = (type: string) =>
			Value.Check(backlogTool.parameters, { op: "add", items: [{ title: "Old", type, ...READY }] });
		expect(declared("feature")).toBe(true);
		for (const type of ["task", "nope"]) expect(declared(type)).toBe(false);
		await expect(t.backlog({ op: "add", items: [{ title: "Old", type: "nope", ...READY }] })).rejects.toThrow(
			/Unknown item type nope: use epic, feature, bug, research/,
		);
		await expect(t.backlog({ op: "add", items: [{ title: "Old", type: "task", ...READY }] })).rejects.toThrow(
			/Unknown item type task/,
		);
		expect(await t.backlog({ op: "add", items: [{ title: "New", type: "feature", ...READY }] })).toBe(
			"Added B1 [backlog p2] New",
		);
		expect(t.store().get("B1")!.type).toBe("feature");
		expect(await t.backlog({ op: "edit", items: [{ id: "B1", type: "bug" }] })).not.toContain("Note:");
		await expect(t.backlog({ op: "add", items: [{ title: "Bad", type: "nope", ...READY }] })).rejects.toThrow(
			/Unknown item type nope/,
		);
	});

	it("shows an epic's state derived from its items", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ title: "Group", type: "epic", ...READY }] });
		await t.backlog({ op: "add", items: [{ title: "Child", parentId: "B1", state: "ongoing", ...READY }] });
		const detail = await t.backlog({ op: "get", id: "B1" });
		expect(detail).toContain("B1 [backlog p2 epic] Group");
		expect(detail).toContain("State from its items: ongoing");
	});

	it("retrieves a saved completion lesson without inventing one for other items", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ title: "Work", state: "ongoing", ...READY }] });
		const lesson = "Check invalidation after resume";
		await t.backlog({ op: "done", id: "B1", completion: { ...completed(), lesson } });
		expect(t.store().get("B1")!.completions.at(-1)?.lesson).toBe(lesson);
		expect(await t.backlog({ op: "get", id: "B1" })).toContain(`Lesson: ${lesson}`);
		await t.backlog({ op: "add", items: [{ title: "Other work", state: "ongoing", ...READY }] });
		await t.backlog({ op: "done", id: "B2", completion: completed() });
		expect(await t.backlog({ op: "get", id: "B2" })).not.toContain("Lesson:");
	});
});
