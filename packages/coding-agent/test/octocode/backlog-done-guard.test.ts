import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { holdingsOf } from "../../src/octocode/compose-backlog.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { type Holdings, overlapping } from "../../src/octocode/backlog/done-guard.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import type { WorkRow } from "../../src/octocode/shared/running-work.ts";
import { PARENT_HOLDS_LEASES_ENV } from "../../src/octocode/team/store/env.ts";
import { timerWorkRows } from "../../src/octocode/timer/work.ts";
import { worktreesMadeFor } from "../../src/octocode/subagents/worktree-owned.ts";
import { worktreesDir } from "../../src/octocode/worktree-paths/own-worktree.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-done-guard-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const READY = { goal: "Result can be checked", why: "Users need it" };
const DONE = { summary: "did it", verification: "passed: ran the check", files: [] };

interface Held {
	children: Map<string, string>;
	work: WorkRow[];
	locks: string[];
	trees: string[];
}

/** A registered backlog tool whose holdings the test edits between calls. */
function setup() {
	const held: Held = { children: new Map(), work: [], locks: [], trees: [] };
	const holdings: Holdings = {
		children: () => held.children,
		work: () => held.work,
		locks: () => held.locks,
		worktrees: () => held.trees,
	};
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false, holdings });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd, idle: false });
	const call = async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	const store = () => new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
	const open = async (items: Array<Record<string, unknown>> = [{ title: "Work", paths: ["src/a/"] }]) => {
		await call({ op: "add", items: items.map((item) => ({ ...READY, state: "todo", ...item })) });
		await call({ op: "claim", id: "B1" });
	};
	return { held, call, store, open };
}

const holds: Array<[string, (h: Held) => void, RegExp]> = [
	["a running child", (h) => h.children.set("sly-mantle", "B1"), /child sly-mantle works on B1/],
	[
		"a bash job started for it",
		(h) => h.work.push({ kind: "bash", id: "bash-3", title: "yarn test", item: "B1" }),
		/bash job bash-3 runs for B1/,
	],
	[
		"a timer set for it",
		(h) => h.work.push({ kind: "timer", id: "#4", title: "after 5m", items: ["B1"] }),
		/timer #4 was set for B1/,
	],
	["a reservation on its paths", (h) => h.locks.push("src/"), /reservation src\/ covers the item's paths/],
	["a worktree made for it", (h) => h.trees.push("wild-otter"), /worktree wild-otter was made for B1/],
];

describe("done waits for what this session still holds for the item", () => {
	it.each(holds)("refuses done while %s, naming it, and allows it once released", async (_name, hold, named) => {
		const t = setup();
		await t.open();
		hold(t.held);
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow(named);
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow(/Release:.*close it/s);
		expect(t.store().get("B1")?.state).toBe("ongoing");
		t.held.children.clear();
		t.held.work.length = 0;
		t.held.locks.length = 0;
		t.held.trees.length = 0;
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.store().get("B1")?.state).toBe("done");
	});

	it("names every holding at once", async () => {
		const t = setup();
		await t.open();
		t.held.children.set("sly-mantle", "B1");
		t.held.work.push({ kind: "bash", id: "bash-3", title: "x", item: "b1" });
		t.held.locks.push("src/a/b.ts");
		const error = await t.call({ op: "done", id: "B1", completion: DONE }).catch((e: Error) => e.message);
		expect(error).toMatch(/sly-mantle/);
		expect(error).toMatch(/bash-3/);
		expect(error).toMatch(/src\/a\/b\.ts/);
	});

	it("ignores work for other items and other paths", async () => {
		const t = setup();
		await t.open([{ title: "Work", paths: ["src/a/"] }, { title: "Other" }]);
		t.held.children.set("sly-mantle", "B2");
		t.held.work.push(
			{ kind: "bash", id: "bash-3", title: "x", item: "B2" },
			{ kind: "timer", id: "#1", title: "x", items: ["B2"] },
		);
		t.held.locks.push("docs/");
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.store().get("B1")?.state).toBe("done");
	});

	it("counts a child working on an item derived from it (a sub-item or one that came from it)", async () => {
		const t = setup();
		await t.open([{ title: "Epic", type: "epic" }]);
		t.store().add({ title: "Part", ...READY, state: "todo", parentId: "B1", createdBy: "user" });
		t.store().add({ title: "Spin-off", ...READY, state: "todo", from: "B1", createdBy: "user" });
		t.held.children.set("part-child", "B2");
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow(
			/child part-child works on B2, derived from B1/,
		);
		t.held.children.clear();
		t.held.children.set("spin-child", "B3");
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow(
			/child spin-child works on B3, derived from B1/,
		);
	});

	it.each([
		["obsolete", { kind: "obsolete", text: "gone" }],
		["wont_do", { kind: "wont_do", text: "not doing it" }],
		["duplicate", { kind: "duplicate", of: "B2", text: "same as B2" }],
	])("never blocks close as %s", async (_kind, close) => {
		const t = setup();
		await t.open([{ title: "Work", paths: ["src/a/"] }, { title: "Original" }]);
		t.held.children.set("sly-mantle", "B1");
		t.held.work.push({ kind: "bash", id: "bash-3", title: "x", item: "B1" });
		t.held.locks.push("src/");
		await t.call({ op: "close", id: "B1", close });
		expect(t.store().get("B1")?.closed?.kind).toBe(close.kind);
	});
});

describe("a child checks its own resources only", () => {
	const api = {} as never;
	const team = (locks: string[]) =>
		({
			id: "me",
			members: () => [
				{ id: "peer", locks: ["src/"] },
				{ id: "me", locks },
			],
		}) as never;

	it("sees only this agent's reservations, not a peer's", () => {
		expect(holdingsOf(api, team(["a/"]), false, () => new Map()).locks()).toEqual(["a/"]);
	});

	it("holds none of the paths its parent reserved for it", () => {
		process.env[PARENT_HOLDS_LEASES_ENV] = "1";
		try {
			expect(holdingsOf(api, team(["a/"]), true, () => new Map()).locks()).toEqual([]);
			expect(holdingsOf(api, team(["a/"]), false, () => new Map()).locks()).toEqual(["a/"]);
		} finally {
			delete process.env[PARENT_HOLDS_LEASES_ENV];
		}
	});

	it("reads the running work of its own api and the children it was given", () => {
		const holdings = holdingsOf(api, team([]), true, () => new Map([["kid", "B9"]]));
		expect(holdings.children().get("kid")).toBe("B9");
		expect(holdings.work()).toEqual([]);
	});
});

describe("what the guard reads", () => {
	it("matches reservations to paths either way, tree or file", () => {
		expect(overlapping(["src/"], ["src/a/x.ts"])).toEqual(["src/"]);
		expect(overlapping(["src/a/x.ts"], ["src/a/"])).toEqual(["src/a/x.ts"]);
		expect(overlapping(["./src/a"], ["src/a"])).toEqual(["./src/a"]);
		expect(overlapping(["src/ab/"], ["src/a/"])).toEqual([]);
		expect(overlapping(["src/"], [])).toEqual([]);
	});

	it("names the items a timer's note mentions, and none for a wait on an item's state", () => {
		const row = (over: Record<string, unknown>) =>
			({
				id: 1,
				status: "active",
				kind: "once",
				note: "check b12 and B7 again, B12",
				created_at: 0,
				due_at: 1,
				condition_kind: null,
				...over,
			}) as never;
		expect(timerWorkRows([row({})])[0].items).toEqual(["B12", "B7"]);
		expect(timerWorkRows([row({ note: "no refs here" })])[0].items).toBeUndefined();
		expect(timerWorkRows([row({ condition_kind: "item" })])[0].items).toBeUndefined();
	});

	it("lists the worktrees kept for an item that this process owns", () => {
		const home = path.join(tmp, "octo");
		const repo = path.join(tmp, "git");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		const dir = worktreesDir(repo, home);
		fs.mkdirSync(path.join(dir, "mine"), { recursive: true });
		fs.mkdirSync(path.join(dir, "theirs"), { recursive: true });
		const record = (name: string, body: Record<string, unknown>) =>
			fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body));
		record("mine", { item: "B1", owners: [{ pid: process.pid }] });
		record("theirs", { item: "B1", owners: [{ pid: process.pid + 1 }] });
		record("gone", { item: "B1", owners: [{ pid: process.pid }] });
		expect(worktreesMadeFor(repo, "B1", process.pid, home)).toEqual(["mine"]);
		expect(worktreesMadeFor(repo, "B2", process.pid, home)).toEqual([]);
	});
});
