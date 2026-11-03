import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const READY = { goal: "Result can be checked", why: "Users need it" };
const PARENT = "session-parent";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-list-filters-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** The `backlog` and `task` tools of one session in the repository `repo` (a subagent of `PARENT` when asked). */
function setup(subagent = false) {
	const fake = fakeHost();
	registerBacklog(fake.api, {
		commands: new Subcommands(),
		isSubagent: subagent,
		...(subagent ? { agentId: () => "child-1", env: { ...process.env, [PARENT_SESSION_ENV]: PARENT } } : {}),
	});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const call = (name: string) => async (params: Record<string, unknown>) => {
		const tool = fake.tools.get(name);
		// Validate as the agent loop does: `backlog` validates against its declared schema plus the call's `reason`.
		const args = tool.validationParameters ? { reason: "test", ...params } : params;
		const valid = validateToolArguments(tool, { type: "toolCall", id: "id", name, arguments: args } as never);
		const result = (await tool.execute("id", valid, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	return { fake, backlog: call("backlog"), task: call("steps") };
}

/** The item ids a list shows, in its order. */
const refs = (text: string) => text.match(/^B\d+/gm) ?? [];

/**
 * B1 epic "Search epic" (todo) holding B2 feature p1 #search #db and B3 bug p0 #search that depends on B2;
 * B4 research p3 #ranking in triage, derived from B2; B5 feature p2 claimed by this session.
 */
async function board() {
	const t = setup();
	await t.backlog({ op: "add", ...READY, title: "Search epic", type: "epic", state: "todo" });
	await t.backlog({
		op: "add",
		...READY,
		title: "Add search index",
		parentId: "B1",
		priority: "p1",
		tags: ["search", "db"],
		paths: ["packages/a/src/index.ts"],
		state: "todo",
	});
	await t.backlog({
		op: "add",
		...READY,
		title: "Fix search crash",
		type: "bug",
		parentId: "B1",
		priority: "p0",
		tags: ["search"],
		paths: ["packages/b/crash.ts"],
		dependsOn: ["B2"],
		state: "todo",
	});
	await t.backlog({
		op: "add",
		...READY,
		title: "Survey ranking",
		type: "research",
		priority: "p3",
		tags: ["ranking"],
		from: "B2",
	});
	await t.backlog({ op: "add", ...READY, title: "Unrelated work", state: "todo" });
	await t.backlog({ op: "update", id: "B5", state: "ongoing" });
	return t;
}

const ALL = ["backlog", "todo", "ongoing", "done"];

describe("backlog list filters", () => {
	it("filters by ids, title words, parent, type, priority, tags and path prefixes", async () => {
		const t = await board();
		// ids list every state unless states narrows them; any id form parseRef reads is accepted.
		expect(refs(await t.backlog({ op: "list", ids: ["B4", "b2"] }))).toEqual(["B2", "B4"]);
		expect(refs(await t.backlog({ op: "list", ids: ["B4", "B2"], states: ["todo"] }))).toEqual(["B2"]);
		await expect(t.backlog({ op: "list", ids: ["nope"] })).rejects.toThrow(/nope is not an item id/);
		// Title words match in any order, case-insensitively.
		expect(refs(await t.backlog({ op: "list", title: "search" }))).toEqual(["B3", "B2", "B1"]);
		expect(refs(await t.backlog({ op: "list", title: "CRASH fix" }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", parentId: "B1" }))).toEqual(["B3", "B2"]);
		await expect(t.backlog({ op: "list", parentId: "B9" })).rejects.toThrow(/No backlog item B9/);
		expect(refs(await t.backlog({ op: "list", type: "bug" }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", type: "feature" }))).toEqual(["B5", "B2"]);
		expect(refs(await t.backlog({ op: "list", type: "epic" }))).toEqual(["B1"]);
		// A priority keeps it and every more urgent one.
		expect(refs(await t.backlog({ op: "list", priority: "p1" }))).toEqual(["B3", "B2"]);
		// A list field matches any entry; tags match whole, with or without #.
		expect(refs(await t.backlog({ op: "list", tags: ["ranking", "db"], states: ALL }))).toEqual(["B2", "B4"]);
		expect(refs(await t.backlog({ op: "list", tags: ["#search"] }))).toEqual(["B3", "B2"]);
		expect(refs(await t.backlog({ op: "list", tags: ["sea"] }))).toEqual([]);
		expect(refs(await t.backlog({ op: "list", paths: ["packages/a"] }))).toEqual(["B2"]);
		expect(refs(await t.backlog({ op: "list", paths: ["./packages/b/", "packages/a/src"] }))).toEqual(["B3", "B2"]);
		expect(refs(await t.backlog({ op: "list", paths: ["a/src"] }))).toEqual([]);
		expect(refs(await t.backlog({ op: "list", from: "B2", states: ["backlog"] }))).toEqual(["B4"]);
	});

	it("filters by dependencies, blocked state, holder and update time", async () => {
		const t = await board();
		expect(refs(await t.backlog({ op: "list", dependsOn: ["B2"] }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", dependsOn: ["B3"] }))).toEqual([]);
		expect(refs(await t.backlog({ op: "list", blocked: true }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", blocked: false }))).toEqual(["B5", "B2", "B1"]);
		expect(refs(await t.backlog({ op: "list", assignee: "me" }))).toEqual(["B5"]);
		expect(await t.backlog({ op: "list", assignee: "someone-else" })).toBe(
			'No ongoing/todo items (filters: assignee).\n1 proposed item(s) await triage (list with states: ["backlog"]).',
		);
		expect(refs(await t.backlog({ op: "list", since: "1h" }))).toEqual(["B5", "B3", "B2", "B1"]);
		expect(refs(await t.backlog({ op: "list", since: "2999-01-01T00:00:00Z" }))).toEqual([]);
		await expect(t.backlog({ op: "list", since: "yesterday-ish" })).rejects.toThrow(/since needs an ISO time/);
		// A subagent's "me" is the parent session it works for: here no item is held by that session.
		const child = setup(true);
		expect(refs(await child.backlog({ op: "list", assignee: "me" }))).toEqual([]);
		// A subagent filters by hierarchy and dependencies too, though it cannot write them (backlog.test.ts).
		expect(refs(await child.backlog({ op: "list", parentId: "B1" }))).toEqual(["B3", "B2"]);
		expect(refs(await child.backlog({ op: "list", dependsOn: ["B2"] }))).toEqual(["B3"]);
		expect(refs(await child.backlog({ op: "list", ids: ["B3"], title: "crash" }))).toEqual(["B3"]);
		await expect(
			child.backlog({ op: "add", ...READY, title: "nested", parentId: "B1", dependsOn: ["B2"] }),
		).rejects.toThrow("A subagent proposal cannot set parentId, dependsOn:");
	});

	it("sorts by creation or update and combines every filter", async () => {
		const t = await board();
		expect(refs(await t.backlog({ op: "list", sort: "created" }))).toEqual(["B5", "B3", "B2", "B1"]);
		await t.backlog({ op: "update", id: "B2", note: "touched" });
		expect(refs(await t.backlog({ op: "list", sort: "updated" }))[0]).toBe("B2");
		await expect(t.backlog({ op: "list", sort: "random" })).rejects.toThrow();
		expect(
			refs(
				await t.backlog({ op: "list", parentId: "B1", tags: ["search"], type: "bug", priority: "p0", blocked: true }),
			),
		).toEqual(["B3"]);
		expect(await t.backlog({ op: "list", parentId: "B1", type: "bug", title: "index", query: "crash" })).toBe(
			'No ongoing/todo items matching "crash" (filters: title, parentId, type).\n1 proposed item(s) await triage (list with states: ["backlog"]).',
		);
		// Empty lists filter nothing, like omitted ones.
		expect(refs(await t.backlog({ op: "list", tags: [], ids: [] }))).toEqual(["B5", "B3", "B2", "B1"]);
	});

	it("filters by creation time, as an age or an ISO time, and pins an age in Next", async () => {
		const t = await board();
		expect(refs(await t.backlog({ op: "list", createdSince: "1h" }))).toEqual(["B5", "B3", "B2", "B1"]);
		expect(refs(await t.backlog({ op: "list", createdSince: "2999-01-01T00:00:00Z" }))).toEqual([]);
		// An update moves since but not createdSince.
		await t.backlog({ op: "update", id: "B2", note: "touched" });
		const cut = new Date(Date.now() + 1000).toISOString();
		expect(refs(await t.backlog({ op: "list", createdSince: cut }))).toEqual([]);
		await expect(t.backlog({ op: "list", createdSince: "soon" })).rejects.toThrow(/createdSince needs an ISO time/);
		const first = await t.backlog({ op: "list", createdSince: "1d", limit: 1 });
		const args = JSON.parse(first.match(/^Next: backlog (.*)$/m)![1]) as Record<string, unknown>;
		expect(String(args.createdSince)).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(await t.backlog({ op: "list", createdSince: "2999-01-01T00:00:00Z", type: "bug" })).toContain(
			"(filters: type, createdSince)",
		);
	});

	it("pages a filtered list with a Next call that repeats the filters", async () => {
		const t = await board();
		const first = await t.backlog({ op: "list", parentId: "B1", since: "1d", limit: 1 });
		expect(refs(first)).toEqual(["B3"]);
		const next = first.match(/^Next: backlog (.*)$/m)?.[1];
		expect(next).toBeDefined();
		const args = JSON.parse(next!) as Record<string, unknown>;
		// The age became a fixed time, so the next page lists the same set.
		expect(args).toMatchObject({ op: "list", states: ["ongoing", "todo"], parentId: "B1", limit: 1, offset: 1 });
		expect(String(args.since)).toMatch(/^\d{4}-\d\d-\d\dT/);
		const second = await t.backlog(args);
		expect(refs(second)).toEqual(["B2"]);
		expect(second).not.toContain("Next:");
	});

	it("declares the list filters on the parent's schema", () => {
		const { fake } = setup();
		const properties = fake.tools.get("backlog").parameters.properties as Record<string, { description?: string }>;
		for (const field of ["ids", "assignee", "blocked", "since", "createdSince", "sort"])
			expect(properties).toHaveProperty(field);
		for (const field of ["title", "type", "parentId", "priority", "tags", "paths", "dependsOn", "from"])
			expect(properties[field].description).toContain("list:");
	});
});

describe("task list filters", () => {
	it("lists one task by id in any state and an epic's items' tasks", async () => {
		const t = await board();
		await t.task({ op: "add", goal: "Index step", item: "B2" });
		await t.task({ op: "add", goal: "Crash step", item: "B3" });
		await t.task({ op: "add", goal: "Other step", item: "B5" });
		await t.task({ op: "update", id: "T1", state: "done", result: "built" });
		expect(await t.task({ op: "list", id: "T1" })).toBe("T1 [done] Index step (B2) — built");
		await expect(t.task({ op: "list", id: "T9" })).rejects.toThrow(/No step T9/);
		expect(await t.task({ op: "list", item: "B1" })).toBe("T2 [todo] Crash step (B3)");
		expect(await t.task({ op: "list", item: "B1", state: "done" })).toBe("T1 [done] Index step (B2) — built");
		expect(await t.task({ op: "list", item: "B2" })).toBe("No open steps.");
		await expect(t.task({ op: "list", item: "B9" })).rejects.toThrow(/No backlog item B9/);
	});
});
