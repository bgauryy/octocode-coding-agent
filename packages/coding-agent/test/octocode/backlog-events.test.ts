import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { closeSharedAgentDb, history } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BACKLOG_EVENTS_TYPE } from "../../src/octocode/backlog/task-events.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import type * as BacklogContext from "../../src/octocode/backlog/context.ts";

/** Boards opened through `openBacklog`: the follower opens one per span, not one per tool result. */
const opens = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/octocode/backlog/context.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof BacklogContext>();
	return {
		...actual,
		openBacklog: (...args: Parameters<typeof actual.openBacklog>) => {
			opens.count++;
			return actual.openBacklog(...args);
		},
	};
});

const READY = { goal: "Result can be checked", why: "Users need it" };
/** The second session on the same workspace. */
const OTHER = { id: "other-session", surface: "tool" as const };

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-events-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

type Message = { message: { customType: string; content: string } } | undefined;

function setup(child?: { agentId: string; item: string }) {
	const fake = fakeHost();
	const env = child
		? { ...process.env, [PARENT_SESSION_ENV]: "session-test", [BACKLOG_ITEM_ENV]: child.item }
		: process.env;
	registerBacklog(fake.api, {
		commands: new Subcommands(),
		isSubagent: Boolean(child),
		env,
		...(child ? { agentId: () => child.agentId } : {}),
	});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const base = fakeCtx({ cwd, idle: false });
	const ctx = child
		? { ...base, sessionManager: { ...base.sessionManager, getSessionId: () => `${child.agentId}-session` } }
		: base;
	const call = async (params: Record<string, unknown>) => {
		const result = (await fake.tools
			.get(backlogToolName(params.op))
			.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	const start = () => fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	/** The events message of the next user turn, if any. */
	const turn = async () => {
		const results = (await fake.emit(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "go" },
			ctx,
		)) as Message[];
		return results.find((result) => result?.message.customType === BACKLOG_EVENTS_TYPE)?.message.content;
	};
	const toolResult = () => fake.emit("tool_result", { type: "tool_result", toolName: "bash", content: [] }, ctx);
	/** Events delivered during a run, right after a tool result. */
	const urgent = () => fake.sent.filter((sent) => sent.message.customType === BACKLOG_EVENTS_TYPE);
	const store = () => new BacklogStore(() => workspaceDb(cwd).agent, workspaceDb(cwd).workspace.id);
	return { fake, call, start, turn, toolResult, urgent, store, cwd };
}

describe("foreign backlog changes (V5)", () => {
	it("tells the holder once at its next user turn, never about its own writes", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Held", state: "todo" }] });
		await t.start();
		await t.turn();
		await t.call({ op: "claim", id: "B1" });
		await t.call({ op: "edit", items: [{ id: "B1", priority: "p1" }] });
		await t.toolResult();
		expect(t.urgent()).toHaveLength(0);
		const own = await t.turn();
		expect(own ?? "").not.toMatch(/elsewhere/);

		t.store().update("B1", { priority: 0 }, OTHER);
		t.store().update("B1", { title: "Held, renamed" }, OTHER);
		await t.toolResult();
		expect(t.urgent()).toHaveLength(0);
		const event = (await t.turn())!;
		// Two writes, one event: collapsed to the newest version (the task line follows it).
		expect(event.match(/by other-session/g)).toHaveLength(1);
		expect(event).toMatch(/B1 v\d+ ongoing "Held, renamed" by other-session/);
		expect(await t.turn()).toBeUndefined();
	});

	it("sends a close or reassignment of a held item right after the tool result", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Held", state: "todo" }] });
		await t.call({ op: "add", items: [{ ...READY, title: "Also held", state: "todo" }] });
		await t.start();
		await t.call({ op: "claim", id: "B1" });
		await t.call({ op: "claim", id: "B2" });
		await t.turn();
		t.store().update("B1", { close: { kind: "obsolete", text: "Not needed" } }, { ...OTHER, kind: "human" });
		await t.toolResult();
		expect(t.urgent()).toHaveLength(1);
		expect(t.urgent()[0].message.content).toMatch(/B1 v\d+ closed by other-session/);
		expect(t.urgent()[0].options).toMatchObject({ deliverAs: "steer" });
		// Sent once: the next turn does not repeat it.
		expect((await t.turn()) ?? "").not.toMatch(/B1 v\d+ closed/);
		t.store().update("B2", { state: "todo" }, { ...OTHER, kind: "human" });
		await t.toolResult();
		expect(t.urgent()).toHaveLength(2);
		expect(t.urgent()[1].message.content).toMatch(/B2 v\d+ todo "Also held" released by other-session/);
	});

	it("opens the board once per span, and still sends an urgent change made after it", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Held", state: "todo" }] });
		await t.start();
		await t.call({ op: "claim", id: "B1" });
		await t.turn();
		const opened = opens.count;
		for (let i = 0; i < 5; i++) await t.toolResult();
		t.store().update("B1", { close: { kind: "obsolete", text: "Not needed" } }, { ...OTHER, kind: "human" });
		await t.toolResult();
		await t.toolResult();
		expect(opens.count).toBe(opened);
		expect(t.urgent()).toHaveLength(1);
		expect(t.urgent()[0].message.content).toMatch(/B1 v\d+ closed by other-session/);
		// A new span opens it again (other session_start handlers open their own too).
		await t.start();
		expect(opens.count).toBeGreaterThan(opened);
	});

	it("answers a pruned cursor with one resync event", async () => {
		const t = setup();
		await t.call({ op: "add", items: [{ ...READY, title: "Held", state: "todo" }] });
		await t.start();
		await t.call({ op: "claim", id: "B1" });
		await t.turn();
		t.store().update("B1", { priority: 0 }, OTHER);
		const { agent } = workspaceDb(t.cwd);
		agent.transaction(() =>
			history.deleteRows(
				agent.db,
				"backlog_audits",
				history.rowsBefore(agent.db, "backlog_audits", Number.MAX_SAFE_INTEGER, 1000).slice(0, -1),
			),
		);
		const event = (await t.turn())!;
		expect(event.match(/re-read/g)).toHaveLength(1);
		expect(event).not.toMatch(/by other-session/);
		expect(await t.turn()).toBeUndefined();
	});

	it("follows the delegated item in a subagent too", async () => {
		const parent = setup();
		await parent.call({ op: "add", items: [{ ...READY, title: "Delegated", state: "todo" }] });
		await parent.call({ op: "claim", id: "B1" });
		const child = setup({ agentId: "general-1", item: "B1" });
		await child.start();
		await child.turn();
		await child.call({ op: "note", id: "B1", note: "started" });
		child.store().update("B1", { close: { kind: "wont_do", text: "Dropped" } }, { ...OTHER, kind: "human" });
		await child.toolResult();
		expect(child.urgent()).toHaveLength(1);
		expect(child.urgent()[0].message.content).toMatch(/B1 v\d+ closed by other-session/);
	});
});
