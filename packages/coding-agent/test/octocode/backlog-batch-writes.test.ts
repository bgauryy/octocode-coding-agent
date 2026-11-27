import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-writes-")));
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
	const tool = (op: unknown) => fake.tools.get(backlogToolName(op));
	const call = async (params: Record<string, unknown>) =>
		(await tool(params.op).execute("id", params, undefined, undefined, fakeCtx({ cwd }))) as {
			content: Array<{ text: string }>;
			details?: unknown;
		};
	const text = async (params: Record<string, unknown>) => (await call(params)).content[0].text;
	await text({
		op: "add",
		items: [
			{ title: "first", goal: "first done", why: "needed", state: "todo", priority: "p1" },
			{ title: "second", goal: "second done", why: "needed", state: "todo", type: "bug" },
			{ title: "third", goal: "third done", why: "needed" },
		],
	});
	return { call, text, tool };
}

describe("backlog write replies", () => {
	it("names the item's head and the version a later write's version check takes", async () => {
		const { text } = await setup();
		const reply = await text({ op: "note", id: "B2", note: "looked" });
		const version = Number(reply.match(/^Updated B2 \[todo p2 bug\] v(\d+)$/)?.[1]);
		expect(version).toBeGreaterThan(0);
		await expect(text({ op: "note", id: "B2", note: "stale", version: version - 1 })).rejects.toThrow();
		expect(await text({ op: "note", id: "B2", note: "fresh", version })).toMatch(
			new RegExp(`^Updated B2 \\[todo p2 bug\\] v${version + 1}$`),
		);
	});
});

describe("backlog batched writes", () => {
	it("applies each entry in order, reports a refused one on its own line, and keeps the rest", async () => {
		const { text } = await setup();
		const out = await text({
			op: "note",
			items: [
				{ id: "B1", note: "one" },
				{ id: "B9", note: "missing" },
				{ id: "B3", note: "three" },
			],
		});
		const lines = out.split("\n");
		expect(lines[0]).toMatch(/2 of 3/);
		expect(lines).toHaveLength(4);
		expect(lines[1]).toMatch(/^Updated B1 /);
		expect(lines[2]).toMatch(/B9/);
		expect(lines[3]).toMatch(/^Updated B3 /);
		expect(await text({ op: "get", id: "B1" })).toContain("one");
		expect(await text({ op: "get", id: "B3" })).toContain("three");
	});

	it("claims several items and closes several in one call, through the same rules as single calls", async () => {
		const { text } = await setup();
		expect(await text({ op: "claim", items: [{ id: "B1" }, { id: "B2" }] })).toMatch(/2 of 2/);
		const closed = await text({
			op: "close",
			items: [
				{ id: "B1", close: { kind: "obsolete", text: "not needed" } },
				{ id: "B3", close: { kind: "wont_do", text: "out of scope" } },
			],
		});
		expect(closed).toMatch(/2 of 2/);
		expect(closed).toMatch(/B1 \[closed/);
		expect(closed).toMatch(/B3 \[closed/);
	});

	it("refuses a whole batch when every entry fails, and fields beside items", async () => {
		const { text } = await setup();
		await expect(
			text({
				op: "note",
				items: [
					{ id: "B8", note: "x" },
					{ id: "B9", note: "y" },
				],
			}),
		).rejects.toThrow(/0 of 2/);
		await expect(text({ op: "note", note: "shared", items: [{ id: "B1" }] })).rejects.toThrow(/note/);
		await expect(text({ op: "note", items: [{ id: "B1", note: "x", why: "y" }] })).rejects.toThrow(/why/);
	});

	it("types each entry in the validation schema as the single call's fields", async () => {
		const { tool } = await setup();
		const backlog = tool("note");
		const check = (args: Record<string, unknown>) =>
			validateToolArguments(
				{ name: "backlog", description: "", parameters: backlog.validationParameters ?? backlog.parameters },
				{ type: "toolCall", id: "c", name: "backlog", arguments: { reason: "r", ...args } },
			);
		expect(() => check({ op: "note", items: [{ id: "B1", note: "x" }] })).not.toThrow();
		expect(() => check({ op: "note", items: [{ id: "B1", note: { text: "x" } }] })).toThrow();
		expect(() => check({ op: "note", items: [] })).toThrow();
	});
});

describe("backlogPlan stat", () => {
	it("counts matching items by state, priority and type with no rows, under the list filters", async () => {
		const { call, text } = await setup();
		await text({ op: "close", id: "B3", close: { kind: "obsolete", text: "gone" } });
		const all = await call({ op: "stat", states: ["todo", "backlog", "closed"] });
		expect(all.details).toEqual({
			total: 3,
			states: { todo: 2, closed: 1 },
			priorities: { 1: 1, 2: 2 },
			types: { feature: 2, bug: 1 },
		});
		expect(all.content[0].text).not.toMatch(/first|second|third/);
		const bugs = await call({ op: "stat", states: ["todo"], ofType: "bug" });
		expect(bugs.details).toMatchObject({ total: 1, types: { bug: 1 } });
		const none = await call({ op: "stat", query: "nothing matches this" });
		expect(none.details).toMatchObject({ total: 0 });
		expect(none.content[0].text).toMatch(/^0 /);
	});
});

describe("backlog get notes", () => {
	it("shows the last three notes and a Next call that reads the rest", async () => {
		const { text } = await setup();
		for (let i = 0; i < 6; i++) await text({ op: "note", id: "B1", note: `entry-${i}` });
		const first = await text({ op: "get", id: "B1" });
		expect([...first.matchAll(/entry-(\d)/g)].map((m) => m[1]).sort()).toEqual(["3", "4", "5"]);
		const next = JSON.parse(first.match(/^Next: backlog (.+)$/m)![1]) as Record<string, unknown>;
		const rest = await text(next);
		expect([...rest.matchAll(/entry-(\d)/g)].map((m) => m[1]).sort()).toEqual(["0", "1", "2"]);
		expect(rest).not.toContain("Next: backlog");
	});
});
