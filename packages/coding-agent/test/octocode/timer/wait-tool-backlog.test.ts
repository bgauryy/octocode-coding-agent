import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, backlog as queries, openDatabase, timers } from "../../../../db/src/api.ts";
import { registeredWorkspace } from "../../../src/storage/workspace-database.ts";
import { classify } from "../../../src/octocode/shared/backlog-classify.ts";
import { BACKLOG_CHANGE_CHANNEL } from "../../../src/octocode/shared/backlog-change.ts";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";
import { tmp } from "../helpers.ts";
import { backlogFixtureFor } from "./backlog-wait-fixture.ts";

const PEER = { id: "peer-agent" };
let root: string;
let agent: AgentDb;
let workspaceId: string;

beforeEach(() => {
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		mirrorFile: path.join(root, "transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	workspaceId = registeredWorkspace(root, agent).id;
});
afterEach(() => {
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

function session(reservation: (absolute: string) => string | undefined = () => undefined) {
	const host = fakeHost();
	const agentDir = path.join(root, "agent-home");
	fs.mkdirSync(agentDir, { recursive: true });
	registerTimers(host.api, {
		reservation,
		agent: () => "me",
		env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "workspaces.db") },
		agentDir,
	});
	const ctx = {
		...fakeCtx({ cwd: root }),
		sessionManager: { getSessionId: () => "s1", getBranch: () => [], getEntries: () => [] },
	};
	return { host, ctx };
}

describe("the wait tool on backlog events", () => {
	it("stores the audit cursor at the start, refuses what could never be met, and wakes on the feed", async () => {
		const board = backlogFixtureFor(agent, workspaceId);
		board.add({ title: "Peer work", goal: "checkable", why: "needed", createdBy: "user" });
		board.update("B1", { state: "ongoing" }, PEER);
		board.update("B1", { note: "before" }, PEER);
		const { host, ctx } = session();
		await host.fire("session_start", { reason: "startup" }, ctx);
		const on = (args: object) =>
			host.tools.get("wait").execute("c", { op: "on", note: "n", ...args }, undefined, undefined, ctx);

		await expect(on({ event: "item.changed", filter: { ref: "B9" } })).rejects.toThrow(/No backlog item B9/);
		await expect(on({ event: "item.changed", filter: { ref: "B1" }, once: false })).rejects.toThrow(/wakes once/);
		await expect(on({ event: "peer.landed", filter: { ref: "B9" } })).rejects.toThrow(/No backlog item B9/);
		await expect(on({ event: "peer.landed", filter: { ref: "B1", path: "src/a" } })).rejects.toThrow(
			/No other agent reserves src\/a/,
		);
		expect(timers.activeCount(agent.db, "s1")).toBe(0);

		const head = queries.snapshot(agent.db, workspaceId).cursor;
		await on({ event: "item.changed", filter: { ref: "B1" } });
		const [row] = timers.activeUntil(agent.db, "s1");
		expect(row.condition_kind).toBe("item");
		expect(JSON.parse(row.condition!)).toMatchObject({ kind: "changed", ref: "B1", since: head });

		board.update("B1", { note: "files are free" }, PEER);
		const page = queries.auditAfter(agent.db, workspaceId, head, 50);
		if (page.resync) throw new Error("resync");
		const change = page.rows.map(classify).find((each) => each?.kind === "note");
		host.api.channels.emit(BACKLOG_CHANGE_CHANNEL, { change, own: false });
		await vi.waitFor(() => expect(timers.get(agent.db, row.id)).toMatchObject({ status: "done", stop_reason: "met" }), {
			timeout: 4000,
		});
		expect(timers.get(agent.db, row.id)!.last_output).toContain("B1 note by peer-agent: files are free");
		await host.fire("session_shutdown", {}, ctx);
	});

	it("sets peer.landed on a path another agent reserves", async () => {
		const board = backlogFixtureFor(agent, workspaceId);
		board.add({ title: "Peer work", goal: "checkable", why: "needed", createdBy: "user" });
		const { host, ctx } = session((absolute) => (absolute.endsWith("src/a") ? "peer holds src/a" : undefined));
		await host.fire("session_start", { reason: "startup" }, ctx);
		const result = await host.tools
			.get("wait")
			.execute(
				"c",
				{ op: "on", note: "n", event: "peer.landed", filter: { ref: "B1", path: "src/a" } },
				undefined,
				undefined,
				ctx,
			);
		expect(result.content[0].text).toContain("B1 landed or src/a released");
		await host.fire("session_shutdown", {}, ctx);
	});
});
