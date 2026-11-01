// B347 P2-2 and P2-3 (promoted from the plucky-nautilus review tests): a stalled but live member stays addressable by
// name, and a question whose asker left stops counting as awaiting a reply and is listed with its id and sender.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { STALE_MS } from "../../src/octocode/team/store/limits.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const started: Array<{
	team: Team;
	emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>;
	ctx: unknown;
}> = [];
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
		const entry = { team, ctx, emit: fake.emit, tools: fake.tools };
		started.push(entry);
		return entry;
	};
	const sql = (statement: string, ...args: Array<string | number>) => {
		const raw = new DatabaseSync(file);
		try {
			return raw.prepare(statement).all(...args) as Array<Record<string, unknown>>;
		} finally {
			raw.close();
		}
	};
	return { agent, sql };
}

const list = async (entry: { tools: Map<string, unknown>; ctx: unknown }): Promise<string> => {
	const coordinate = entry.tools.get("coordinate") as {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
	};
	const result = await coordinate.execute("call-1", { action: "list" }, undefined, undefined, entry.ctx);
	return result.content.map((part) => part.text).join("\n");
};

const pendingOf = (team: Team, id: string): number | undefined =>
	team.snapshot().members.find((member) => member.id === id)?.pending;

describe("a stalled but live member (P2-2)", () => {
	it("stays addressable by id, and the sender is told it is stalled", async () => {
		const { agent, sql } = setup();
		const sender = await agent();
		const receiver = await agent();
		sql("UPDATE agents SET seen_at = seen_at - ? WHERE id = ?", STALE_MS + 5_000, receiver.team.id!);
		const result = await sender.team.send(receiver.team.id, "hello");
		expect(result).toMatchObject({ sent: [receiver.team.id], delivery: { [receiver.team.id!]: "stalled" } });
		// Still hidden from listings and broadcasts: only a named recipient reaches it.
		expect(await list(sender)).not.toContain(receiver.team.id!);
		expect(await sender.team.send("all", "anyone?")).toEqual({ error: expect.stringContaining("No other agents") });
	});
});

describe("questions whose asker left (P2-3)", () => {
	async function asked() {
		const { agent, sql } = setup();
		const asker = await agent();
		const answerer = await agent();
		const sent = await asker.team.send(answerer.team.id, "which build do you use?", { replyRequired: true });
		if (!("id" in sent)) throw new Error(sent.error);
		// The answerer read it (what the inbox drain records).
		sql("UPDATE deliveries SET delivered_at = ? WHERE message = ?", Date.now(), sent.id);
		return { asker, answerer, id: sent.id, sql };
	}

	it("lists an open question with its id and sender", async () => {
		const { asker, answerer, id } = await asked();
		expect(pendingOf(answerer.team, answerer.team.id!)).toBe(1);
		const listed = await list(answerer);
		expect(listed).toContain(`#${id} from ${asker.team.id}`);
		expect(listed).toContain("which build do you use?");
	});

	it("closes a question when its asker leaves the team", async () => {
		const { asker, answerer, id } = await asked();
		asker.team.leave();
		expect(pendingOf(answerer.team, answerer.team.id!)).toBe(0);
		expect(await list(answerer)).not.toContain(`#${id}`);
	});

	it("closes a question whose answer cannot be delivered, and says so", async () => {
		const { asker, answerer, id, sql } = await asked();
		// The asker's row is gone without the retire path (a crashed process that another member reaped later).
		sql("DELETE FROM agents WHERE id = ?", asker.team.id!);
		const reply = await answerer.team.send(undefined, "the answer", { replyTo: id });
		expect(reply).toEqual({ error: expect.stringContaining(`question #${id} is closed`) });
		expect(pendingOf(answerer.team, answerer.team.id!)).toBe(0);
	});

	it("does not count a relay request its parent holds", async () => {
		const { agent, sql } = setup();
		const parent = await agent();
		const child = await agent();
		const sent = await child.team.send(parent.team.id, "pass this on", { replyRequired: true });
		if (!("id" in sent)) throw new Error(sent.error);
		sql("UPDATE deliveries SET relay_to = 'someone-else', delivered_at = ? WHERE message = ?", Date.now(), sent.id);
		expect(pendingOf(parent.team, parent.team.id!)).toBe(0);
	});
});
