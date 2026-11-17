import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BACKLOG_DIGEST_TYPE } from "../../src/octocode/backlog/digest.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";

const READY = { goal: "Result can be checked", why: "Users need it" };

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-digest-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup(isSubagent = false) {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const backlog = async (params: Record<string, unknown>) => {
		const result = (await fake.tools
			.get(backlogToolName(params.op))
			.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	const start = (reason: string) => fake.fire("session_start", { type: "session_start", reason }, ctx);
	const prompt = () =>
		fake.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, ctx) as Promise<
			{ message: { customType: string; content: string; display: boolean } } | undefined
		>;
	/** An ongoing item whose holder session does not exist (it ended), touched just now: inside the window before its claim is returned. */
	const abandoned = (seq: number, title: string) =>
		sharedAgentDb()
			.db.prepare(
				"INSERT INTO backlog (workspace_id, seq, title, state, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, 'ongoing', 'ended-session', 'user', 0, ?)",
			)
			.run(registeredWorkspace(cwd).id, seq, title, Date.now());
	return { backlog, start, prompt, abandoned };
}

describe("backlog session-start digest", () => {
	it("gives a fresh main session its claims, stale claims, counts and top open titles once", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ ...READY, title: "Mine", state: "ongoing" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Urgent accepted", state: "todo", priority: "p0" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Plain accepted", state: "todo" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Urgent idea", priority: "p1" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Someday idea", priority: "p3" }] });
		t.abandoned(50, "Left behind");
		await t.start("startup");
		const result = await t.prompt();
		expect(result?.message).toMatchObject({ customType: BACKLOG_DIGEST_TYPE, display: false });
		const text = result!.message.content;
		expect(text).toContain("2 to do, 2 proposed");
		expect(text).toContain('Ongoing: B1 "Mine" (yours); B50 "Left behind" (stale: holder ended)');
		expect(text).toContain('Top open: B2 p0 "Urgent accepted"; B4 p1 "Urgent idea"');
		expect(text).not.toMatch(/Plain accepted|Someday/);
		expect(text.length).toBeLessThanOrEqual(400);
		expect(await t.prompt()).toBeUndefined();
	});

	it("sends the versioned index on resume, nothing in a subagent or on an empty board", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ ...READY, title: "Accepted", state: "todo" }] });
		await t.start("resume");
		expect((await t.prompt())?.message.content).toMatch(/Top open: B1 v1 todo p2 "Accepted"/);
		const child = setup(true);
		await child.start("startup");
		expect(await child.prompt()).toBeUndefined();
		fs.rmSync(path.join(tmp, "home"), { recursive: true, force: true });
		closeSharedAgentDb();
		const empty = setup();
		await empty.start("new");
		expect(await empty.prompt()).toBeUndefined();
	});
});

describe("backlog list default", () => {
	it("lists ongoing, todo and proposed items by priority, caps at 15 rows with a more line, and flags stale claims", async () => {
		const t = setup();
		t.abandoned(90, "Left behind");
		for (let i = 0; i < 16; i++)
			await t.backlog({ op: "add", items: [{ ...READY, title: `Idea ${i}`, priority: i === 15 ? "p0" : "p2" }] });
		const first = await t.backlog({ op: "list" });
		const lines = first.split("\n");
		expect(lines[0]).toBe("B90 [ongoing p2] Left behind (@ended-session) (stale: holder ended)");
		expect(lines[1]).toMatch(/^B106 \[backlog p0\] Idea 15/);
		expect(lines.filter((line) => /^B\d+ /.test(line))).toHaveLength(15);
		expect(lines).toContain("2 more.");
		expect(lines.at(-1)).toMatch(/^Next: backlogPlan .*"offset":15/);
		expect(await t.backlog({ op: "list", states: ["backlog"], limit: 20 })).not.toContain("more.");
	});
});
