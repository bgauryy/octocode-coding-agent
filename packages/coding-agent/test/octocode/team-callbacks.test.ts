// A callback rides beside a message: replyRequired is sugar for `callback: { on: "reply" }`, a reply settles the asker's
// ticket once, and the result reaches the asker through the wake gate.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { MAX_PENDING_PER_REQUESTER } from "../../src/octocode/events/tickets.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";

const started: Array<{ emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>; ctx: unknown }> = [];
afterEach(async () => {
	for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
});

function setup() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(tmp(), "team.sqlite");
	const agent = async () => {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: file });
		registerCollab(fake.api, team, {});
		const ctx = fakeCtx({ cwd, hasUI: true });
		await fake.emit("session_start", {}, ctx);
		team.join();
		started.push({ emit: fake.emit, ctx });
		return { team, ctx, emit: fake.emit };
	};
	const sql = (statement: string, ...args: Array<string | number>) => {
		const raw = new DatabaseSync(workspaceDb(cwd, { ...process.env, OCTOCODE_AGENT_DB: file }).agent.file);
		try {
			return raw.prepare(statement).all(...args) as Array<Record<string, unknown>>;
		} finally {
			raw.close();
		}
	};
	return { agent, sql };
}

const sentId = (result: Awaited<ReturnType<Team["send"]>>): number => {
	if ("error" in result) throw new Error(result.error);
	return result.id ?? 0;
};
const states = (sql: ReturnType<typeof setup>["sql"]) =>
	sql("SELECT state, on_kind FROM tickets ORDER BY id").map((row) => `${row.on_kind}:${row.state}`);
const results = (sql: ReturnType<typeof setup>["sql"], topic: string) =>
	sql("SELECT seq FROM event_log WHERE topic = ?", topic).length;

describe("callbacks on messages", () => {
	it("a reply resolves the asker's ticket exactly once", async () => {
		const { agent, sql } = setup();
		const asker = await agent();
		const target = await agent();
		const id = sentId(await asker.team.send(target.team.id, "review?", { callback: { on: "reply" } }));
		expect(states(sql)).toEqual(["reply:pending"]);
		sentId(await target.team.send(asker.team.id, "looks good", { replyTo: id }));
		sentId(await target.team.send(asker.team.id, "and again", { replyTo: id }));
		expect(states(sql)).toEqual(["reply:resolved"]);
		expect(results(sql, "ticket.resolved")).toBe(1);
	});

	it("replyRequired is a reply callback and still marks the ask", async () => {
		const { agent, sql } = setup();
		const asker = await agent();
		const target = await agent();
		const id = sentId(await asker.team.send(target.team.id, "state?", { replyRequired: true }));
		expect(states(sql)).toEqual(["reply:pending"]);
		sentId(await target.team.send(asker.team.id, "blocked on X", { replyTo: id }));
		expect(states(sql)).toEqual(["reply:resolved"]);
		const plain = await asker.team.send(target.team.id, "fyi");
		sentId(plain);
		expect(states(sql)).toEqual(["reply:resolved"]);
	});

	it("keeps an open ticket when the asker's session ends and resumes", async () => {
		const { agent, sql } = setup();
		const asker = await agent();
		const target = await agent();
		const id = sentId(await asker.team.send(target.team.id, "review?", { callback: { on: "reply" } }));
		await asker.emit("session_shutdown", {}, asker.ctx);
		expect(states(sql)).toEqual(["reply:pending"]);
		expect(id).toBeGreaterThan(0);
		expect(results(sql, "ticket.rejected")).toBe(0);
	});

	it("refuses a pending flood with clear text, sending nothing", async () => {
		const { agent } = setup();
		const asker = await agent();
		const target = await agent();
		for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++)
			sentId(await asker.team.send(target.team.id, `q${i}`, { callback: { on: "reply" } }));
		const flood = await asker.team.send(target.team.id, "one too many", { callback: { on: "reply" } });
		expect(flood).toEqual({ error: expect.stringMatching(/pending callbacks.*Nothing was sent/s) });
	});
});
