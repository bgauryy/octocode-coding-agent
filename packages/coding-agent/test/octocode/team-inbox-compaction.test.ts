import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const teams: Team[] = [];
const stores: TeamStore[] = [];

afterEach(() => {
	for (const team of teams.splice(0)) team.stop();
	for (const store of stores.splice(0)) store.close();
});

function agent(dbFile: string, cwd: string, branch: () => unknown[] = () => []) {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	registerCollab(fake.api, team);
	const ctx = fakeCtx({ cwd, hasUI: true, idle: true }) as { sessionManager: { getBranch: () => unknown[] } };
	ctx.sessionManager.getBranch = branch;
	team.start(ctx as never);
	teams.push(team);
	return { ...fake, team, ctx };
}

const mail = (sent: Array<{ message: any }>) =>
	sent.filter((entry) => entry.message.customType === INTERNAL_MESSAGE_TYPE && entry.message.details?.messages);

/** Waits until the receiver has been handed `count` mail messages (delivery polls the store). */
const delivered = (sent: Array<{ message: any }>, count: number) =>
	vi.waitFor(() => expect(mail(sent)).toHaveLength(count), { timeout: 5_000, interval: 50 });

const entryFor = (id: string, delivered: { message: any }) => ({
	type: "custom_message",
	id,
	customType: INTERNAL_MESSAGE_TYPE,
	details: delivered.message.details,
});

async function setup() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const dbFile = path.join(tmp(), "team.sqlite");
	const entries: unknown[] = [];
	const sender = agent(dbFile, cwd);
	const receiver = agent(dbFile, cwd, () => entries);
	sender.team.join();
	receiver.team.join();
	return { sender, receiver, entries, cwd, dbFile };
}

const compact = (receiver: Awaited<ReturnType<typeof setup>>["receiver"], firstKeptEntryId: string) =>
	receiver.emit(
		"session_compact",
		{ type: "session_compact", compactionEntry: { id: "compaction", firstKeptEntryId } },
		receiver.ctx,
	);

describe("inbox after compaction", () => {
	it("holds newer mail while earlier mail is unseen (the stall compaction must clear)", async () => {
		const { sender, receiver } = await setup();
		await sender.team.send(receiver.team.id, "first", { replyRequired: false, wake: false });
		await delivered(receiver.sent, 1);
		await sender.team.send(receiver.team.id, "second", { replyRequired: false, wake: false });
		// Proving that nothing arrives needs a fixed window longer than the delivery poll.
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		expect(mail(receiver.sent)).toHaveLength(1);
	}, 15_000);

	it("treats mail summarized away as seen so newer mail flows", async () => {
		const { sender, receiver, entries, cwd, dbFile } = await setup();
		// Quiet mail: a woken turn would pace the second message 30 s behind the first, and this checks compaction only.
		const first = (await sender.team.send(receiver.team.id, "first", { replyRequired: false, wake: false })) as {
			id: number;
		};
		await delivered(receiver.sent, 1);
		// The mail entered the transcript, then compaction summarized it before any model call reported it.
		entries.push(entryFor("e1", mail(receiver.sent)[0]), { type: "message", id: "e2" }, { type: "message", id: "e3" });
		await compact(receiver, "e3");
		await sender.team.send(receiver.team.id, "second", { replyRequired: false, wake: false });
		await delivered(receiver.sent, 2);
		expect(mail(receiver.sent)[1].message.details.messages.map((m: { id: number }) => m.id)).not.toContain(first.id);
		const store = TeamStore.open(cwd, dbFile, {});
		stores.push(store);
		expect(store.pending(receiver.team.id as string, 0).map((m) => m.id)).not.toContain(first.id);
	}, 15_000);

	it("leaves mail in the kept range unseen until a model call reports it", async () => {
		const { sender, receiver, entries } = await setup();
		await sender.team.send(receiver.team.id, "first", { replyRequired: false, wake: false });
		await delivered(receiver.sent, 1);
		entries.push({ type: "message", id: "e1" }, entryFor("e2", mail(receiver.sent)[0]));
		await compact(receiver, "e2");
		await sender.team.send(receiver.team.id, "second", { replyRequired: false, wake: false });
		// Proving that nothing arrives needs a fixed window longer than the delivery poll.
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		expect(mail(receiver.sent)).toHaveLength(1);
	}, 15_000);
});
