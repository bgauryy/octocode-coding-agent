import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BACKLOG_DIGEST_TYPE } from "../../src/octocode/backlog/digest.ts";
import { BACKLOG_EVENTS_TYPE } from "../../src/octocode/backlog/task-events.ts";
import { backlogIndex } from "../../src/octocode/backlog/task-source.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName, planEntryFields } from "./backlog-fixture.ts";

const READY = { goal: "Result can be checked", why: "Users need it" };
const OTHER = { id: "other-session", surface: "tool" as const };

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-task-source-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

type Message = { message: { customType: string; content: string; display: boolean } } | undefined;

function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const call = async (params: Record<string, unknown>) => {
		const result = (await fake.tools
			.get(backlogToolName(params.op))
			.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	const start = (reason: string) => fake.fire("session_start", { type: "session_start", reason }, ctx);
	/** Every message the turn's handlers add, by type. */
	const prompt = async (messageType?: string) => {
		const results = (await fake.emit(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "go", ...(messageType ? { messageType } : {}) },
			ctx,
		)) as Message[];
		return new Map(results.flatMap((result) => (result ? [[result.message.customType, result.message.content]] : [])));
	};
	const store = () => new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
	return { fake, ctx, call, start, prompt, store, cwd };
}

describe("backlog version", () => {
	it("is declared on backlog and on a backlogPlan entry, and a stale one is refused", async () => {
		const t = setup();
		expect(t.fake.tools.get("backlog").parameters.properties.version).toMatchObject({ type: "integer" });
		expect(planEntryFields(t.fake.tools.get("backlogPlan")).version).toMatchObject({ type: "integer" });
		await t.call({ op: "add", items: [{ ...READY, title: "Mine", state: "todo" }] });
		await t.call({ op: "claim", id: "B1", version: 1 });
		t.store().update("B1", { priority: 0 }, OTHER);
		const version = t.store().get("B1")!.version;
		await expect(t.call({ op: "note", id: "B1", note: "progress", version: version - 1 })).rejects.toThrow(
			`B1 changed elsewhere (now version ${version}): get it, then retry.`,
		);
		await expect(t.call({ op: "edit", items: [{ id: "B1", title: "Stale", version: version - 1 }] })).rejects.toThrow(
			/changed elsewhere/,
		);
		expect(t.store().get("B1")!.title).toBe("Mine");
		await t.call({ op: "note", id: "B1", note: "progress", version });
	});
});

describe("backlog index per span", () => {
	it("keeps the startup digest and adds the active item with its version and next step", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Mine", state: "ongoing" }] });
		await t.call({ op: "add", items: [{ ...READY, title: "Urgent accepted", state: "todo", priority: "p0" }] });
		t.store().tasks.add({ goal: "write the parser", item: "B1" }, { id: "session-test", surface: "tool" });
		await t.start("startup");
		const text = (await t.prompt()).get(BACKLOG_DIGEST_TYPE)!;
		expect(text).toContain('Ongoing: B1 "Mine" (yours)');
		expect(text).toContain('Top open: B2 p0 "Urgent accepted"');
		expect(text).toMatch(/Active: B1 v\d+ — goal: Result can be checked — next: T1 write the parser/);
		expect(text.length).toBeLessThanOrEqual(400);
	});

	it("appends the versioned index at the first prompt after a resume, once", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Mine", state: "ongoing" }] });
		await t.call({ op: "add", items: [{ ...READY, title: "Later", state: "todo" }] });
		await t.start("resume");
		const text = (await t.prompt()).get(BACKLOG_DIGEST_TYPE)!;
		expect(text).toContain("1 to do, 0 proposed");
		expect(text).toMatch(/Ongoing: B1 v\d+ ongoing "Mine" \(yours\) — goal: Result can be checked/);
		expect(text).toMatch(/Top open: B2 v1 todo p2 "Later"/);
		expect((await t.prompt()).get(BACKLOG_DIGEST_TYPE)).toBeUndefined();
	});

	it("renders the index for the compaction note from one snapshot, capped at ten refs", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Mine", state: "ongoing" }] });
		for (let i = 0; i < 12; i++) await t.call({ op: "add", items: [{ ...READY, title: `Idea ${i}` }] });
		const text = backlogIndex(sharedAgentDb(), registeredWorkspace(t.cwd).id, "session-test")!;
		expect(text).toContain("0 to do, 12 proposed");
		expect(text.match(/B\d+ v\d+/g)).toHaveLength(10);
		expect(text).toContain("3 more");
		expect(backlogIndex(sharedAgentDb(), "no-such-workspace", "session-test")).toBeUndefined();
	});
});

describe("backlog task line", () => {
	it("is sent on a user turn only when it changed", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Mine", state: "ongoing" }] });
		await t.start("startup");
		expect((await t.prompt()).get(BACKLOG_EVENTS_TYPE)).toBeUndefined();
		await t.call({ op: "add", items: [{ ...READY, title: "Second" }] });
		const line = (await t.prompt()).get(BACKLOG_EVENTS_TYPE)!;
		expect(line).toMatch(/^active B1 v\d+ ongoing · open 2$/m);
		expect((await t.prompt()).get(BACKLOG_EVENTS_TYPE)).toBeUndefined();
		// A turn the agent starts itself (a custom message) carries no line.
		await t.call({ op: "add", items: [{ ...READY, title: "Third" }] });
		expect((await t.prompt("custom")).get(BACKLOG_EVENTS_TYPE)).toBeUndefined();
		expect((await t.prompt()).get(BACKLOG_EVENTS_TYPE)).toMatch(/open 3/);
	});
});
