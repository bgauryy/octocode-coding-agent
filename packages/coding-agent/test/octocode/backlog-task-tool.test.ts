import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV, READ_ONLY_ENV } from "../../../common/src/env.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";

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

/** The `backlog` and `task` tools of one session (a subagent when `env` names its parent) in the repository `repo`. */
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
	const caller = (name: string) => async (params: Record<string, unknown>) =>
		(
			(await fake.tools.get(name).execute("id", params, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	return {
		...fake,
		ctx,
		backlog: caller("backlog"),
		task: caller("steps"),
		store: storeOfRepo,
	};
}

/** The store of the repository the tools open: the same key `openBacklog` computes. */
function storeOfRepo(): BacklogStore {
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	return new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
}

describe("task tool", () => {
	it("adds, updates and lists session tasks, and get shows an item's tasks", async () => {
		const t = setup();
		// `why` is the task's stored reason; the call's own `reason` (every tool takes one) is the registry's, never stored.
		expect(
			await t.task({ op: "add", goal: "Read the loader", why: "Find where config is read", reason: "Track a step" }),
		).toBe("Added T1 [todo] Read the loader (session)");
		expect(t.store().tasks.get("T1")!.reason).toBe("Find where config is read");
		expect(await t.task({ op: "update", id: "T1", why: "Config is read twice" })).toContain("Updated T1");
		expect(t.store().tasks.get("T1")!.reason).toBe("Config is read twice");
		expect(await t.task({ op: "update", id: "T1", state: "ongoing" })).toBe(
			"Updated T1 [ongoing] Read the loader (session)",
		);
		expect(await t.task({ op: "add", goal: "Patch it", state: "ongoing" })).toContain("T2 [ongoing]");
		expect(await t.task({ op: "update", id: "T1", state: "done", result: "in config.ts" })).toBe(
			"Updated T1 [done] Read the loader (session) — in config.ts",
		);
		// One step in detail shows its own why; a list stays one line per step.
		expect(await t.task({ op: "list", id: "T1" })).toBe(
			"T1 [done] Read the loader (session) — in config.ts\n  why: Config is read twice",
		);
		expect(await t.task({ op: "list" })).toBe("T2 [ongoing] Patch it (session)");
		expect(await t.task({ op: "list", state: "done" })).toBe("T1 [done] Read the loader (session) — in config.ts");
		await t.task({ op: "update", id: "T2", why: "The loader drops overrides" });
		await expect(t.task({ op: "update", id: "T2" })).rejects.toThrow(/needs something to change/);
		await expect(t.task({ op: "add" })).rejects.toThrow(/needs a goal/);
		await expect(t.task({ op: "update", goal: "x" })).rejects.toThrow(/needs an id/);

		await t.backlog({ op: "add", title: "Work", state: "ongoing", ...READY });
		await t.task({ op: "add", goal: "Under B1" });
		const detail = await t.backlog({ op: "get", id: "B1" });
		expect(detail).toContain("Steps (1):\n- T3 [todo] Under B1");
	});

	it("puts a task under the one item the session holds, and asks for item when it holds several", async () => {
		const t = setup();
		await t.backlog({ op: "add", title: "First", state: "todo", ...READY });
		await t.backlog({ op: "add", title: "Second", state: "todo", ...READY });
		expect(await t.task({ op: "add", goal: "Loose step" })).toBe("Added T1 [todo] Loose step (session)");
		await t.backlog({ op: "update", id: "B1", state: "ongoing" });
		expect(await t.task({ op: "add", goal: "Step of B1" })).toBe("Added T2 [todo] Step of B1 (B1)");
		await t.backlog({ op: "update", id: "B2", state: "ongoing" });
		await expect(t.task({ op: "add", goal: "Which one?" })).rejects.toThrow(
			/^You hold B1, B2: pass item to say which one the step goes under\./,
		);
		expect(await t.task({ op: "add", goal: "Step of B2", item: "B2" })).toContain("(B2)");
		// list: this session's tasks, then those of the items it holds; one item's tasks with item.
		expect((await t.task({ op: "list" })).split("\n")).toEqual([
			"T1 [todo] Loose step (session)",
			"T2 [todo] Step of B1 (B1)",
			"T3 [todo] Step of B2 (B2)",
		]);
		expect(await t.task({ op: "list", item: "B2" })).toBe("T3 [todo] Step of B2 (B2)");
		expect(await t.task({ op: "list", item: "B1", state: "done" })).toBe("No done steps.");
	});

	it("declares list, add and update only, and names the removed move and promote ops", async () => {
		const t = setup();
		const tool = t.tools.get("steps");
		expect(tool.parameters.properties.op.enum).toEqual(["list", "add", "update"]);
		expect(tool.parameters.properties.position).toBeUndefined();
		await t.task({ op: "add", goal: "A step" });
		for (const op of ["move", "promote"]) {
			const message = new RegExp(`"${op}" was removed: steps take list, add and update`);
			await expect(t.task({ op, id: "T1", position: 0 })).rejects.toThrow(message);
			expect(() => tool.prepareArguments({ op, id: "T1" })).toThrow(message);
		}
		expect(t.store().tasks.get("T1")!.owner).toMatchObject({ kind: "session" });
	});

	it("shows the tree: type, parent, blocked-by, open steps, stale claims and an epic's items", async () => {
		const t = setup();
		await t.backlog({ op: "add", title: "Group", type: "epic", ...READY });
		await t.backlog({ op: "add", title: "Prereq", parentId: "B1", type: "bug", ...READY });
		await t.backlog({ op: "add", title: "Waits", parentId: "B1", dependsOn: ["B2"], state: "todo", ...READY });
		await t.backlog({ op: "add", title: "Mine", state: "ongoing", ...READY });
		t.store().update("B2", { state: "ongoing" }, { id: "gone-session" });
		await t.task({ op: "add", goal: "Draft", item: "B3" });
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
		await t.backlog({ op: "add", title: "Group", type: "epic", ...READY });
		await t.backlog({ op: "add", title: "Child", parentId: "B1", state: "ongoing", ...READY });
		await t.backlog({ op: "update", id: "B2", state: "done", completion: completed() });
		await t.backlog({ op: "update", id: "B1", state: "done", completion: completed() });
		await t.backlog({ op: "add", title: "Base", state: "ongoing", ...READY });
		await t.backlog({ op: "update", id: "B3", state: "done", completion: completed() });
		await t.backlog({ op: "add", title: "Built on base", dependsOn: ["B3"], state: "ongoing", ...READY });
		await t.backlog({ op: "update", id: "B4", state: "done", completion: completed() });
		expect(await t.backlog({ op: "update", id: "B2", state: "todo", note: "Regression" })).toContain(
			"\nNeeds review (done): B1 (parent of B2).",
		);
		expect(await t.backlog({ op: "update", id: "B3", state: "todo", note: "Regression" })).toContain(
			"\nNeeds review (done): B4 (depends on B3).",
		);
		const done = await t.backlog({ op: "list", states: ["done"] });
		expect(done).toContain("B1 [done p2 epic] Group (needs review: B2 open)");
		expect(done).toContain("B4 [done p2] Built on base (needs review: B3 open)");
		// Reopening something nothing waited on says nothing.
		await t.backlog({ op: "add", title: "Alone", state: "ongoing", ...READY });
		await t.backlog({ op: "update", id: "B5", state: "done", completion: completed() });
		expect(await t.backlog({ op: "update", id: "B5", state: "todo", note: "Again" })).not.toContain("Needs review");
	});

	it("refuses to move an epic with items between states, but lets it close and reopen", async () => {
		const t = setup();
		await t.backlog({ op: "add", title: "Group", type: "epic", ...READY });
		// No items yet: the stored state is the epic's own.
		expect(await t.backlog({ op: "update", id: "B1", state: "ongoing" })).toContain("[ongoing");
		await t.backlog({ op: "add", title: "Child", parentId: "B1", state: "ongoing", ...READY });
		for (const state of ["backlog", "todo"])
			await expect(t.backlog({ op: "update", id: "B1", state })).rejects.toThrow(
				/^B1 is an epic with items: its state follows them\./,
			);
		await t.backlog({ op: "update", id: "B2", state: "done", completion: completed() });
		await t.backlog({ op: "update", id: "B1", state: "done", completion: completed() });
		expect(await t.backlog({ op: "update", id: "B1", state: "todo", note: "More to do" })).toContain("[todo");
	});

	it("refuses to close an item with open tasks, naming them, and closes it once they end", async () => {
		const t = setup();
		await t.backlog({ op: "add", title: "Work", state: "ongoing", ...READY });
		await t.task({ op: "add", goal: "Step one" });
		await t.task({ op: "add", goal: "Step two" });
		await expect(t.backlog({ op: "update", id: "B1", state: "done", completion: completed() })).rejects.toThrow(
			/^B1 has open tasks: T1, T2: finish or drop them first\./,
		);
		await t.task({ op: "update", id: "T1", state: "done" });
		await t.task({ op: "update", id: "T2", state: "dropped", result: "not needed" });
		await expect(t.backlog({ op: "update", id: "B1", state: "done", completion: completed() })).resolves.toContain(
			"[done",
		);
	});

	it("refuses the former item type task like any unknown type", async () => {
		const t = setup();
		const backlogTool = t.tools.get("backlog");
		expect(JSON.stringify(backlogTool.parameters)).not.toContain('"task"');
		const call = { name: "backlog", arguments: { op: "add", title: "Old", type: "feature", reason: "r", ...READY } };
		expect(() => validateToolArguments(backlogTool, { type: "toolCall", id: "1", ...call } as never)).not.toThrow();
		for (const type of ["task", "nope"]) {
			expect(() =>
				validateToolArguments(backlogTool, {
					type: "toolCall",
					id: "1",
					...call,
					arguments: { ...call.arguments, type },
				} as never),
			).toThrow();
		}
		await expect(t.backlog({ op: "add", title: "Old", type: "task", ...READY })).rejects.toThrow(
			/Unknown item type task/,
		);
		expect(await t.backlog({ op: "add", title: "New", type: "feature", ...READY })).toBe("Added B1 [backlog p2] New");
		expect(t.store().get("B1")!.type).toBe("feature");
		expect(await t.backlog({ op: "update", id: "B1", type: "bug" })).not.toContain("Note:");
		await expect(t.backlog({ op: "add", title: "Bad", type: "nope", ...READY })).rejects.toThrow(
			/Unknown item type nope/,
		);
	});

	it("shows an epic's state derived from its items", async () => {
		const t = setup();
		await t.backlog({ op: "add", title: "Group", type: "epic", ...READY });
		await t.backlog({ op: "add", title: "Child", parentId: "B1", state: "ongoing", ...READY });
		const detail = await t.backlog({ op: "get", id: "B1" });
		expect(detail).toContain("B1 [backlog p2 epic] Group");
		expect(detail).toContain("State from its items: ongoing");
		await expect(t.task({ op: "add", goal: "On an epic", item: "B1" })).rejects.toThrow(
			/B1 is an epic: epics group items and hold no steps \(its open items: B2\)\. Pass one of its items as item, or omit item/,
		);
	});

	describe("as a subagent", () => {
		const child = (item?: string) => ({
			id: "child-1",
			env: { [PARENT_SESSION_ENV]: SESSION, ...(item ? { [BACKLOG_ITEM_ENV]: item } : {}) },
		});

		it("tracks steps under its own item by default, and on its session without one", async () => {
			const store = storeOfRepo();
			for (const title of ["Mine", "Sibling"])
				store.update(
					store.add({ ...READY, title, state: "todo", createdBy: "user" }).ref,
					{ state: "ongoing" },
					{ id: SESSION },
				);
			const withItem = setup({ subagent: child("B1") });
			expect(await withItem.task({ op: "add", goal: "Check the schema" })).toBe(
				"Added T1 [todo] Check the schema (B1)",
			);
			expect(await withItem.task({ op: "list" })).toBe("T1 [todo] Check the schema (B1)");
			await expect(withItem.task({ op: "add", goal: "Not mine", item: "B2" })).rejects.toThrow(
				/B2 is not your item: your parent started you for B1/,
			);
			const bare = setup({ subagent: child() });
			expect(await bare.task({ op: "add", goal: "Own step" })).toBe("Added T2 [todo] Own step (session)");
			expect(store.tasks.get("T2")!.owner).toEqual({ kind: "session", id: "child-1" });
		});

		it("cannot touch tasks of items its parent does not hold", async () => {
			const store = storeOfRepo();
			store.add({ ...READY, title: "Unclaimed", state: "todo", createdBy: "user" });
			const t = setup({ subagent: child() });
			await expect(t.task({ op: "add", goal: "Sneak", item: "B1" })).rejects.toThrow(
				/B1 is not claimed by your parent.*Ask your parent to claim it \(agent message to parent\), or add session steps without an item\./,
			);
			await expect(t.backlog({ op: "update", id: "B1", state: "ongoing" })).rejects.toThrow(
				/B1 is not claimed by your parent.*Ask your parent to claim it \(agent message to parent\), or put the finding in your report\./,
			);
			const own = await t.task({ op: "add", goal: "Own" });
			expect(own).toContain("T1");
			expect(t.tools.get("steps").parameters.properties.op.enum).toEqual(["list", "add", "update"]);
			const parent = setup();
			await expect(parent.task({ op: "update", id: "T1", state: "done" })).rejects.toThrow(/belong to session child-1/);
		});

		it("a read-only role follows the same subagent rules", async () => {
			const t = setup({ subagent: { ...child(), env: { ...child().env, [READ_ONLY_ENV]: "1" } } });
			expect(await t.task({ op: "add", goal: "Review step" })).toBe("Added T1 [todo] Review step (session)");
			await expect(t.task({ op: "add", goal: "Sneak", item: "B9" })).rejects.toThrow(/No backlog item B9/);
		});
	});

	it("renders the call with T<n> and goal, and the result as a title line", async () => {
		const t = setup();
		const tool = t.tools.get("steps");
		expect(rendered(tool.renderCall({ op: "add", goal: "Read the loader", item: "B3" }, theme, {}))).toBe(
			'○ Steps(add in B3 "Read the loader")',
		);
		expect(rendered(tool.renderCall({ op: "update", id: "T7", state: "done" }, theme, {}))).toBe(
			"○ Steps(update T7 → done)",
		);
		const row = async (params: Record<string, unknown>) => {
			const result = await t.tools.get("steps").execute("id", params, undefined, undefined, t.ctx);
			return rendered(
				tool.renderResult(result, { expanded: false }, theme, { args: params, isPartial: false, expanded: false }),
			);
		};
		expect(await row({ op: "add", goal: "Read the loader" })).toBe("  ⎿  Added T1 · todo · Read the loader");
		expect(await row({ op: "update", id: "T1", state: "done" })).toBe("  ⎿  T1 → done · Read the loader");
		expect(await row({ op: "list", state: "done" })).toMatch(/^ {2}⎿ {2}1 step\n {5}T1 \[done\]/);
	});

	it("states the quick-work threshold and what happens to open steps, once, for every role that has the tool", () => {
		const main = setup().tools.get("steps");
		const child = setup({ subagent: { id: "c", env: { [PARENT_SESSION_ENV]: SESSION } } }).tools.get("steps");
		expect(main.description).toBe(child.description);
		expect(main.promptSnippet).toBe(child.promptSnippet);
		for (const tool of [main, child]) {
			expect(tool.promptGuidelines).toHaveLength(1);
			expect(tool.promptGuidelines[0].length).toBeLessThan(330);
			// The quick-work threshold is the snippet's (when to use the tool); the guideline owns the lifecycle.
			expect(tool.promptSnippet).toContain("skip it for one step or a few calls");
			expect(tool.promptGuidelines[0]).not.toContain("one step");
			expect(tool.promptGuidelines[0]).toContain("Set a step ongoing when you start it");
			// Unfinished steps persist and are resumed; only a step decided against is dropped.
			expect(tool.promptGuidelines[0]).toContain("Leave unfinished steps todo");
			expect(tool.promptGuidelines[0]).not.toContain("before you report");
		}
		expect(child.promptGuidelines[0]).toContain("pass to your parent");
		expect(main.promptGuidelines[0]).not.toContain("pass to your parent");
		// `backlog` says what an item is, not when a step is a task.
		expect(setup().tools.get("backlog").promptGuidelines.join(" ")).not.toContain("One-step");
	});
});
