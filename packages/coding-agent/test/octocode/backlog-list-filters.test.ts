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
import { backlogToolName, planEntryFields } from "./backlog-fixture.ts";

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

/** The backlog tools of one session in the repository `repo` (a subagent of `PARENT` when asked). */
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
	const call = (named?: string) => async (params: Record<string, unknown>) => {
		const name = named ?? backlogToolName(params.op);
		const tool = fake.tools.get(name);
		// Validate as the agent loop does: `backlog` validates against its declared schema plus the call's `reason`.
		const args = tool.validationParameters ? { reason: "test", ...params } : params;
		const valid = validateToolArguments(tool, { type: "toolCall", id: "id", name, arguments: args } as never);
		const result = (await tool.execute("id", valid, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	return { fake, backlog: call() };
}

/** The item ids a list shows, in its order. */
const refs = (text: string) => text.match(/^B\d+/gm) ?? [];

/**
 * B1 epic "Search epic" (todo) holding B2 feature p1 #search #db and B3 bug p0 #search that depends on B2;
 * B4 research p3 #ranking in triage, derived from B2; B5 feature p2 claimed by this session.
 */
async function board() {
	const t = setup();
	await t.backlog({ op: "add", items: [{ ...READY, title: "Search epic", type: "epic", state: "todo" }] });
	await t.backlog({
		op: "add",
		items: [
			{
				...READY,
				title: "Add search index",
				parentId: "B1",
				priority: "p1",
				tags: ["search", "db"],
				paths: ["packages/a/src/index.ts"],
				state: "todo",
			},
		],
	});
	await t.backlog({
		op: "add",
		items: [
			{
				...READY,
				title: "Fix search crash",
				type: "bug",
				parentId: "B1",
				priority: "p0",
				tags: ["search"],
				paths: ["packages/b/crash.ts"],
				dependsOn: ["B2"],
				state: "todo",
			},
		],
	});
	await t.backlog({
		op: "add",
		items: [
			{
				...READY,
				title: "Survey ranking",
				type: "research",
				priority: "p3",
				tags: ["ranking"],
				from: "B2",
			},
		],
	});
	await t.backlog({ op: "add", items: [{ ...READY, title: "Unrelated work", state: "todo" }] });
	await t.backlog({ op: "claim", id: "B5" });
	return t;
}

const ALL = ["backlog", "todo", "ongoing", "done"];

describe("backlog list filters", () => {
	it("filters by ids, title words, parent, type, priority, tags and path prefixes", async () => {
		const t = await board();
		// Listed ids show every state unless states narrows them; any id form parseRef reads is accepted.
		expect(refs(await t.backlog({ op: "list", ids: ["B4", "b2"] }))).toEqual(["B2", "B4"]);
		expect(refs(await t.backlog({ op: "list", ids: ["B4", "B2"], states: ["todo"] }))).toEqual(["B2"]);
		await expect(t.backlog({ op: "list", ids: ["nope"] })).rejects.toThrow(/nope is not an item id/);
		// `id` names the item an edit changes: a list is told its own filter.
		await expect(t.backlog({ op: "list", id: "B4" })).rejects.toThrow("list does not take id: use ids.");
		// Title words match in any order, case-insensitively.
		expect(refs(await t.backlog({ op: "list", inTitle: "search" }))).toEqual(["B3", "B2", "B1"]);
		expect(refs(await t.backlog({ op: "list", inTitle: "CRASH fix" }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", underEpic: "B1" }))).toEqual(["B3", "B2"]);
		await expect(t.backlog({ op: "list", underEpic: "B9" })).rejects.toThrow(/No backlog item B9/);
		expect(refs(await t.backlog({ op: "list", ofType: "bug" }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", ofType: "feature" }))).toEqual(["B5", "B2"]);
		expect(refs(await t.backlog({ op: "list", ofType: "epic" }))).toEqual(["B1"]);
		// A priority keeps it and every more urgent one.
		expect(refs(await t.backlog({ op: "list", priorityAtLeast: "p1" }))).toEqual(["B3", "B2"]);
		// A list field matches any entry; tags match whole, with or without #.
		expect(refs(await t.backlog({ op: "list", anyTag: ["ranking", "db"], states: ALL }))).toEqual(["B2", "B4"]);
		expect(refs(await t.backlog({ op: "list", anyTag: ["#search"] }))).toEqual(["B3", "B2"]);
		expect(refs(await t.backlog({ op: "list", anyTag: ["sea"] }))).toEqual([]);
		expect(refs(await t.backlog({ op: "list", touchingPaths: ["packages/a"] }))).toEqual(["B2"]);
		expect(refs(await t.backlog({ op: "list", touchingPaths: ["./packages/b/", "packages/a/src"] }))).toEqual([
			"B3",
			"B2",
		]);
		expect(refs(await t.backlog({ op: "list", touchingPaths: ["a/src"] }))).toEqual([]);
		expect(refs(await t.backlog({ op: "list", derivedFrom: "B2", states: ["backlog"] }))).toEqual(["B4"]);
	});

	it("filters by dependencies, blocked state, holder and update time", async () => {
		const t = await board();
		expect(refs(await t.backlog({ op: "list", dependingOn: ["B2"] }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", dependingOn: ["B3"] }))).toEqual([]);
		expect(refs(await t.backlog({ op: "list", blocked: true }))).toEqual(["B3"]);
		expect(refs(await t.backlog({ op: "list", blocked: false }))).toEqual(["B5", "B2", "B1", "B4"]);
		expect(refs(await t.backlog({ op: "list", assignee: "me" }))).toEqual(["B5"]);
		expect(await t.backlog({ op: "list", assignee: "someone-else" })).toBe(
			"No ongoing/todo/backlog items (filters: assignee).",
		);
		expect(refs(await t.backlog({ op: "list", since: "1h" }))).toEqual(["B5", "B3", "B2", "B1", "B4"]);
		expect(refs(await t.backlog({ op: "list", since: "2999-01-01T00:00:00Z" }))).toEqual([]);
		await expect(t.backlog({ op: "list", since: "yesterday-ish" })).rejects.toThrow(/since needs an ISO time/);
		// A subagent's "me" is the parent session it works for: here no item is held by that session.
		const child = setup(true);
		expect(refs(await child.backlog({ op: "list", assignee: "me" }))).toEqual([]);
		// A subagent filters by hierarchy and dependencies too, though it cannot write them (backlog.test.ts).
		expect(refs(await child.backlog({ op: "list", underEpic: "B1" }))).toEqual(["B3", "B2"]);
		expect(refs(await child.backlog({ op: "list", dependingOn: ["B2"] }))).toEqual(["B3"]);
		expect(refs(await child.backlog({ op: "list", ids: ["B3"], inTitle: "crash" }))).toEqual(["B3"]);
		await expect(
			child.backlog({ op: "add", items: [{ ...READY, title: "nested", parentId: "B1", dependsOn: ["B2"] }] }),
		).rejects.toThrow("A subagent proposal cannot set parentId, dependsOn:");
	});

	it("sorts by creation or update and combines every filter", async () => {
		const t = await board();
		expect(refs(await t.backlog({ op: "list", sort: "created" }))).toEqual(["B5", "B4", "B3", "B2", "B1"]);
		await t.backlog({ op: "note", id: "B2", note: "touched" });
		expect(refs(await t.backlog({ op: "list", sort: "updated" }))[0]).toBe("B2");
		await expect(t.backlog({ op: "list", sort: "random" })).rejects.toThrow();
		expect(
			refs(
				await t.backlog({
					op: "list",
					underEpic: "B1",
					anyTag: ["search"],
					ofType: "bug",
					priorityAtLeast: "p0",
					blocked: true,
				}),
			),
		).toEqual(["B3"]);
		expect(await t.backlog({ op: "list", underEpic: "B1", ofType: "bug", inTitle: "index", query: "crash" })).toBe(
			'No ongoing/todo/backlog items matching "crash" (filters: inTitle, underEpic, ofType).',
		);
		// Empty lists filter nothing, like omitted ones.
		expect(refs(await t.backlog({ op: "list", anyTag: [], ids: [] }))).toEqual(["B5", "B3", "B2", "B1", "B4"]);
	});

	it("filters by creation time with sort created, as an age or an ISO time, and pins an age in Next", async () => {
		const t = await board();
		const created = { op: "list", sort: "created" } as const;
		expect(refs(await t.backlog({ ...created, since: "1h" }))).toEqual(["B5", "B4", "B3", "B2", "B1"]);
		expect(refs(await t.backlog({ ...created, since: "2999-01-01T00:00:00Z" }))).toEqual([]);
		// An update moves the update time, not the creation time.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const cut = new Date().toISOString();
		await t.backlog({ op: "note", id: "B2", note: "touched" });
		expect(refs(await t.backlog({ op: "list", since: cut }))).toEqual(["B2"]);
		expect(refs(await t.backlog({ ...created, since: cut }))).toEqual([]);
		await expect(t.backlog({ ...created, since: "soon" })).rejects.toThrow(/since needs an ISO time/);
		const first = await t.backlog({ ...created, since: "1d", limit: 1 });
		const args = JSON.parse(first.match(/^Next: backlogPlan (.*)$/m)![1]) as Record<string, unknown>;
		expect(args).toMatchObject({ sort: "created" });
		expect(String(args.since)).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(await t.backlog({ ...created, since: "2999-01-01T00:00:00Z", ofType: "bug" })).toContain(
			"(filters: ofType, since)",
		);
		// The undeclared `createdSince` still bounds creation time in any order.
		expect(refs(await t.backlog({ op: "list", createdSince: "1h" })).sort()).toEqual(["B1", "B2", "B3", "B4", "B5"]);
		expect(refs(await t.backlog({ op: "list", createdSince: cut }))).toEqual([]);
		await expect(t.backlog({ op: "list", createdSince: "soon" })).rejects.toThrow(/createdSince needs an ISO time/);
	});

	it("pages a filtered list with a Next call that repeats the filters", async () => {
		const t = await board();
		const first = await t.backlog({ op: "list", underEpic: "B1", since: "1d", limit: 1 });
		expect(refs(first)).toEqual(["B3"]);
		const next = first.match(/^Next: backlogPlan (.*)$/m)?.[1];
		expect(next).toBeDefined();
		const args = JSON.parse(next!) as Record<string, unknown>;
		// The age became a fixed time, so the next page lists the same set.
		expect(args).toMatchObject({
			op: "list",
			states: ["ongoing", "todo", "backlog"],
			underEpic: "B1",
			limit: 1,
			offset: 1,
		});
		expect(String(args.since)).toMatch(/^\d{4}-\d\d-\d\dT/);
		const second = await t.backlog(args);
		expect(refs(second)).toEqual(["B2"]);
		expect(second).not.toContain("Next:");
	});

	it("declares every list filter under its own name, so no field has two meanings, and still validates the undeclared ones", () => {
		const { fake } = setup();
		const tool = fake.tools.get("backlogPlan");
		const properties = tool.parameters.properties as Record<string, { description?: string }>;
		const filters = [
			"states",
			"query",
			"ids",
			"inTitle",
			"ofType",
			"underEpic",
			"dependingOn",
			"touchingPaths",
			"priorityAtLeast",
			"anyTag",
			"derivedFrom",
			"since",
			"sort",
			"limit",
			"offset",
		];
		// A filter is named for what it matches; only the ones a name cannot explain carry a description.
		for (const field of ["states", "query", "since", "limit"])
			expect(properties[field].description, field).toBeTruthy();
		// The description says it, so a deferred declaration (no schema) still does.
		expect(tool.description).toContain("list finds items by the other fields");
		for (const field of ["assignee", "blocked", "createdSince"]) expect(properties).not.toHaveProperty(field);
		// Every other field is one `add` and `edit` write, inside an `items` entry, and none of them is also a filter.
		expect(Object.keys(properties).filter((field) => !filters.includes(field))).toEqual(["op", "items"]);
		const written = planEntryFields(tool);
		expect(Object.keys(written)).toEqual(
			expect.arrayContaining(["id", "title", "type", "parentId", "priority", "tags", "paths", "dependsOn", "from"]),
		);
		for (const [field, schema] of Object.entries(written)) {
			expect(filters, field).not.toContain(field);
			expect(schema.description ?? "", field).not.toMatch(/\blist\b/);
		}
		// The work tool has no filter at all.
		expect(Object.keys(fake.tools.get("backlog").parameters.properties)).toEqual(
			expect.not.arrayContaining(["states", "query", "ids", "since", "sort", "limit", "offset"]),
		);
		const undeclared = { reason: "r", op: "list", ids: ["B1"], assignee: "me", blocked: false, createdSince: "1d" };
		expect(
			validateToolArguments(tool, { type: "toolCall", id: "c1", name: "backlogPlan", arguments: undeclared } as never),
		).toMatchObject(undeclared);
	});

	it("answers a write field sent as a filter with the filter that reads it, and a filter sent to add or edit", async () => {
		const t = await board();
		await expect(t.backlog({ op: "list", tags: ["search"], parentId: "B1" })).rejects.toThrow(
			"list does not take tags, parentId: use anyTag, underEpic.",
		);
		await expect(t.backlog({ op: "list", plan: "x" })).rejects.toThrow(
			/list does not take plan: its filters are states, query, ids/,
		);
		await expect(t.backlog({ op: "edit", anyTag: ["db"], items: [{ id: "B2" }] })).rejects.toThrow(
			"edit does not take anyTag: list filters.",
		);
		await expect(t.backlog({ op: "edit", items: [{ id: "B2", anyTag: ["db"] }] })).rejects.toThrow(
			"Unknown items fields: anyTag.",
		);
	});
});
