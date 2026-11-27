import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { openWorkspaceDb } from "../../src/storage/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * What `sendMessage` tells the sender about how each recipient meets its message: `Sent #N to X.`, plus a sentence only
 * for a recipient that will not act on it soon (idle without a wake, stalled, a cooperative runner). The delivery of each
 * recipient stays in the details.
 */

type FakeMember = ReturnType<typeof fakeHost> & { team: Team; ctx: ReturnType<typeof fakeCtx> };
const started: FakeMember[] = [];
function member(dbFile: string, cwd: string): FakeMember {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	registerCollab(fake.api, team);
	const ctx = fakeCtx({ cwd });
	const self: FakeMember = { ...fake, team, ctx };
	started.push(self);
	return self;
}

async function pair() {
	const cwd = tmp();
	const db = path.join(tmp(), "team.sqlite");
	const a = member(db, cwd);
	const b = member(db, cwd);
	await a.emit("session_start", {}, a.ctx);
	await b.emit("session_start", {}, b.ctx);
	return { a, b };
}

const run = (
	tool: {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
	},
	params: unknown,
	ctx: unknown,
) => tool.execute("call-1", params, undefined, undefined, ctx);
const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join("\n");

afterEach(async () => {
	for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
});

describe("sendMessage delivery status", () => {
	it("tells the sender an idle recipient is woken by a new FYI", async () => {
		const { a, b } = await pair();
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		const sent = await run(
			a.tools.get("sendMessage"),
			{ to: b.team.id, message: "the build is broken on arm64" },
			a.ctx,
		);
		expect(sent.details).toMatchObject({ to: [b.team.id], delivery: { [b.team.id!]: "wake" } });
	});

	it("tells the sender an idle FYI with wake: false is read on the next turn, not acted on", async () => {
		const { a, b } = await pair();
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		const sent = await run(
			a.tools.get("sendMessage"),
			{ to: b.team.id, message: "the build is broken on arm64", wake: false },
			a.ctx,
		);
		expect(sent.details).toMatchObject({
			to: [b.team.id],
			delivery: { [b.team.id!]: "queued-quiet" },
		});
		expect(text(sent)).toMatch(
			new RegExp(
				`^Sent #\\d+ to ${b.team.id}\\. ${b.team.id} is idle and will not act on it alone; replyRequired: true asks and wakes\\.`,
			),
		);
	});

	it("says only that it was sent to a busy recipient", async () => {
		const { a, b } = await pair();
		await run(a.tools.get("coordinate"), { action: "join" }, a.ctx);
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		await b.emit("agent_start", {}, b.ctx);
		await vi.waitFor(() => expect(b.team.members().find((entry) => entry.id === b.team.id)!.status).toBe("working"));
		const sent = await run(a.tools.get("sendMessage"), { to: b.team.id, message: "heads-up", wake: false }, a.ctx);
		expect(sent.details).toMatchObject({ delivery: { [b.team.id!]: "next-step" } });
		expect(text(sent)).toMatch(new RegExp(`^Sent #\\d+ to ${b.team.id}\\.$`));
	});

	it("marks a request as asking for a reply", async () => {
		const { a, b } = await pair();
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		const sent = await run(
			a.tools.get("sendMessage"),
			{ to: b.team.id, message: "which file now?", replyRequired: true },
			a.ctx,
		);
		expect(sent.details).toMatchObject({ delivery: { [b.team.id!]: "wake" } });
		expect(text(sent)).toMatch(new RegExp(`^Sent #\\d+ to ${b.team.id} \\(reply requested\\)\\.$`));
	});

	it("wakes an idle recipient with wake: true and adds no sentence", async () => {
		const { a, b } = await pair();
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		const sent = await run(a.tools.get("sendMessage"), { to: b.team.id, message: "please look", wake: true }, a.ctx);
		expect(sent.details).toMatchObject({ delivery: { [b.team.id!]: "wake" } });
		expect(text(sent)).toMatch(new RegExp(`^Sent #\\d+ to ${b.team.id}\\.$`));
	});

	it("refuses wake with to: all, and on a forward, sending nothing", async () => {
		const { a, b } = await pair();
		await run(a.tools.get("coordinate"), { action: "join" }, a.ctx);
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		await expect(run(a.tools.get("sendMessage"), { to: "all", message: "hi", wake: true }, a.ctx)).rejects.toThrow(
			/needs a named recipient.*Nothing was sent/,
		);
		const first = await run(a.tools.get("sendMessage"), { to: b.team.id, message: "fyi" }, a.ctx);
		await expect(
			run(a.tools.get("sendMessage"), { forward: Number(first.details.id), to: b.team.id, wake: true }, a.ctx),
		).rejects.toThrow(/never interrupts or wakes/);
	});

	it("tells the sender a recipient that fell silent after it was resolved is stalled", async () => {
		const cwd = tmp();
		const file = path.join(tmp(), "team.sqlite");
		const a = member(file, cwd);
		const b = member(file, cwd);
		await a.emit("session_start", {}, a.ctx);
		await b.emit("session_start", {}, b.ctx);
		await run(a.tools.get("coordinate"), { action: "join" }, a.ctx);
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		// The recipient was live when the send began; its heartbeat lapses while the message hook runs.
		a.team.setMessageHook(async () => {
			const machine = openAgentDb(file);
			const rows = openWorkspaceDb(machine, cwd).agent;
			try {
				rows.db.prepare("UPDATE agents SET seen_at = ? WHERE id = ?").run(Date.now() - 120_000, b.team.id!);
			} finally {
				if (rows !== machine) rows.close();
				machine.close();
			}
		});
		const sent = await run(a.tools.get("sendMessage"), { to: b.team.id, message: "are you there?" }, a.ctx);
		expect(sent.details).toMatchObject({ to: [b.team.id], delivery: { [b.team.id!]: "stalled" } });
		expect(text(sent)).toMatch(
			new RegExp(
				`${b.team.id} has not been seen for over a minute: the message waits, and you are told if it never recovers \\(it then becomes a dead letter\\)\\.`,
			),
		);
	});

	it("wakes the asker with the answer to its open question, and says so", async () => {
		const { a, b } = await pair();
		await run(a.tools.get("coordinate"), { action: "join" }, a.ctx);
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		const asked = await run(
			b.tools.get("sendMessage"),
			{ to: a.team.id, message: "which file?", replyRequired: true },
			b.ctx,
		);
		const answer = await run(
			a.tools.get("sendMessage"),
			{ message: "src/x.ts", replyTo: Number(asked.details.id) },
			a.ctx,
		);
		expect(answer.details).toMatchObject({ to: [b.team.id], delivery: { [b.team.id!]: "wake" } });
		expect(text(answer)).toMatch(new RegExp(`^Sent #\\d+ to ${b.team.id}\\.$`));
	});
});
