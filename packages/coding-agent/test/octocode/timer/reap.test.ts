import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, openDatabase, timers } from "../../../../db/src/api.ts";
import { registeredWorkspace } from "../../../src/storage/workspace-database.ts";
import { timerFields } from "../../../src/octocode/timer/model.ts";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";
import { tmp } from "../helpers.ts";

const T0 = Date.UTC(2026, 10, 5, 12);
let root: string;
let file: string;
let agent: AgentDb;
let workspaceId: string;
const add = (input: Parameters<typeof timerFields>[0], sessionId: string, now = T0) =>
	timers.insert(agent.db, timerFields(input, now, { workspaceId, sessionId, cwd: root }));
const status = (id: number) => timers.get(agent.db, id)?.status;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"], now: T0 });
	root = tmp();
	file = path.join(root, "workspaces.db");
	agent = openDatabase({
		file,
		mirrorFile: `${file}.transcripts`,
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	workspaceId = registeredWorkspace(root, agent).id;
});
afterEach(() => {
	vi.useRealTimers();
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

/** Starts a session `id` over the shared database and returns its host and context. */
async function start(id: string) {
	const host = fakeHost();
	registerTimers(host.api, {
		reservation: () => undefined,
		agent: () => undefined,
		env: { ...process.env, OCTOCODE_AGENT_DB: file },
	});
	const ctx = { ...fakeCtx({ cwd: root }), sessionManager: { getSessionId: () => id, getBranch: () => [] } };
	await host.fire("session_start", { reason: "resume" }, ctx);
	return { host, ctx };
}

describe("timers of sessions that ended", () => {
	it("expires an until timer past its deadline even though its session never ran again", () => {
		const overdue = add({ note: "a", until: { unlocked: "src/a.ts" }, deadline: 600 }, "gone");
		const open = add({ note: "b", until: { unlocked: "src/a.ts" }, deadline: 7200 }, "gone");
		const once = add({ note: "c", after: 60 }, "gone");
		expect(timers.expireOverdue(agent.db, T0 + 3_600_000)).toBe(1);
		expect(timers.get(agent.db, overdue.id)).toMatchObject({ status: "expired", stop_reason: "deadline" });
		expect([status(open.id), status(once.id)]).toEqual(["active", "active"]);
	});

	it("is done by any session that starts, leaving that session's own overdue wait to its scheduler", async () => {
		const other = add({ note: "a", until: { unlocked: "src/a.ts" }, deadline: 600 }, "gone");
		const own = add({ note: "b", until: { unlocked: "src/a.ts" }, deadline: 600 }, "me");
		vi.setSystemTime(T0 + 3_600_000);
		const { host, ctx } = await start("me");
		expect([status(other.id), status(own.id)]).toEqual(["expired", "active"]);
		await host.fire("session_shutdown", {}, ctx);
	});

	it("does not count a dead owner's timers toward another session's cap or list", async () => {
		for (let i = 0; i < 10; i++) add({ note: `old${i}`, after: 600 }, "gone");
		const { host, ctx } = await start("live");
		const tool = host.tools.get("timer");
		await tool.execute("c1", { op: "set", after: 60, note: "mine" }, undefined, undefined, ctx);
		const list = await tool.execute("c2", { op: "list" }, undefined, undefined, ctx);
		expect(JSON.stringify(list.content)).toContain("mine");
		expect(JSON.stringify(list.content)).not.toContain("old0");
		await host.fire("session_shutdown", {}, ctx);
	});

	it("still fires a resumed session's own due once timer", async () => {
		add({ note: "from before", after: 60 }, "me");
		vi.setSystemTime(T0 + 3_600_000);
		const { host, ctx } = await start("me");
		await vi.advanceTimersByTimeAsync(2000);
		expect(host.sent.map(({ message }) => message.content)).toEqual([expect.stringContaining("Note: from before")]);
		await host.fire("session_shutdown", {}, ctx);
	});
});
