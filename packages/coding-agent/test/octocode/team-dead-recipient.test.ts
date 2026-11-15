import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInstruction } from "../../src/core/prompt-template.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/**
 * A sender whose recipient closed or was killed before reading (or answering) its message hears it exactly once, without
 * a turn being started, soon after the death, and with the next step: a child's report and how to resume or restart it,
 * or, for a peer, to send it to another agent or tell the user.
 */

const SOURCE_RESOLVER = path.join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const WORKER = path.join(import.meta.dirname, "lifecycle-child-worker.ts");
let root: string;
let team: Team;
let host: ReturnType<typeof fakeHost>;
const peers: TeamStore[] = [];
const children: ChildProcess[] = [];

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "researcher",
	pid: process.pid,
	status: "idle",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

/** Every team notice (an entry without a message id) the sender's session got that names `who`, with whether it started a turn. */
const noticesAbout = (who: string) =>
	host.sent
		.filter(
			(entry) =>
				entry.message.customType === INTERNAL_MESSAGE_TYPE &&
				(entry.message.details?.messages ?? []).every((each: { id?: number }) => each.id === undefined) &&
				String(entry.message.content).includes(who),
		)
		.map((entry) => ({ text: String(entry.message.content), turn: entry.options?.triggerTurn === true }));

const peerNext = renderInstruction("notices/mail/dead-letter-next.md", { who: "x", child: false });
const childNext = (who: string, reported: boolean) =>
	renderInstruction("notices/mail/dead-letter-next.md", { who, child: true, reported });

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-dead-recipient-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	host = fakeHost();
	team = new Team(host.api, { OCTOCODE_AGENT_DB: path.join(root, "agent.db") });
	// A session with a file writes presence events, so every notice a real session would get is heard here too.
	const ctx = fakeCtx({ cwd: root, hasUI: false });
	(ctx.sessionManager as { getSessionFile(): string }).getSessionFile = () => path.join(root, "session.jsonl");
	team.start(ctx);
	team.join();
});
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const peer of peers.splice(0)) peer.close();
	team.stop();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function peer(id: string, extra: Partial<Member> = {}): { store: TeamStore; row: Member } {
	const store = TeamStore.open(root, path.join(root, "agent.db"), {});
	store.lifecycle = { activationId: `a-${id}`, sessionId: `s-${id}` };
	peers.push(store);
	const row = member(id, extra);
	store.join(row);
	return { store, row };
}

/** A recipient in a real other process (a peer, or a child of the sender with `parentId`), which can be killed. */
async function processPeer(id: string, parentId?: string): Promise<ChildProcess> {
	const worker = spawn(
		process.execPath,
		["--import", SOURCE_RESOLVER, WORKER, root, path.join(root, "agent.db"), id, ...(parentId ? [parentId] : [])],
		{ stdio: ["pipe", "pipe", "inherit"] },
	);
	children.push(worker);
	await new Promise<void>((resolve, reject) => {
		worker.stdout.on("data", (chunk: Buffer) => /joined /.test(String(chunk)) && resolve());
		worker.once("exit", (code) => reject(new Error(`The worker exited with ${code} before it joined.`)));
	});
	return worker;
}

async function kill(worker: ChildProcess): Promise<number> {
	const gone = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
	worker.kill("SIGKILL");
	await gone;
	return Date.now();
}

const sentId = (result: Awaited<ReturnType<Team["send"]>>): number => {
	if ("error" in result) throw new Error(result.error);
	return result.id;
};

/** Waits for the one notice about `who`, then one more heartbeat to show it does not repeat. */
async function oneNotice(who: string, timeout = 12_000): Promise<{ text: string; turn: boolean }> {
	await vi.waitFor(() => expect(noticesAbout(who).length).toBeGreaterThan(0), { timeout, interval: 100 });
	await new Promise((resolve) => setTimeout(resolve, 6_000));
	const notices = noticesAbout(who);
	expect(notices).toHaveLength(1);
	expect(notices[0].turn).toBe(false);
	return notices[0];
}

describe("a sender whose recipient ended before reading", () => {
	it("(a) hears once and quietly when a peer left cleanly with the message unread, with the peer's next step", async () => {
		const { store, row } = peer("calm-heron");
		const id = sentId(await team.send("calm-heron", "the build is green on arm64"));
		store.remove("calm-heron", Date.now(), row, "completed");
		const notice = await oneNotice("calm-heron");
		expect(notice.text).toContain(`#${id}`);
		expect(notice.text).toContain(peerNext);
	}, 30_000);

	it("(b) hears once within two heartbeats when a peer was killed, with no sweep run by hand", async () => {
		const worker = await processPeer("lost-ibis");
		const id = sentId(await team.send("lost-ibis", "please rebase on main", { replyRequired: false }));
		const died = await kill(worker);
		await vi.waitFor(() => expect(noticesAbout("lost-ibis").length).toBeGreaterThan(0), {
			timeout: 12_000,
			interval: 100,
		});
		// Measured about 4.6 s: one heartbeat reaps the dead pid and reports in the same tick.
		expect(Date.now() - died).toBeLessThan(12_000);
		const notice = await oneNotice("lost-ibis");
		expect(notice.text).toContain(`#${id}`);
	}, 40_000);

	it("(c) hears once about every waking message still queued when a peer was killed, and nothing wakes", async () => {
		const worker = await processPeer("busy-wren");
		// Named new messages wake an idle recipient by default; a second within the pace window waits in its inbox.
		const first = sentId(await team.send("busy-wren", "look at the failing test"));
		const second = sentId(await team.send("busy-wren", "and the flaky one", { wake: true }));
		await kill(worker);
		const notice = await oneNotice("busy-wren");
		expect(notice.text).toContain(`#${first}`);
		expect(notice.text).toContain(`#${second}`);
		expect(host.sent.some((entry) => entry.options?.triggerTurn === true)).toBe(false);
	}, 40_000);

	it("(d) is refused at send time with the peer's next step when the recipient already ended, and hears nothing later", async () => {
		const { store, row } = peer("gone-lark");
		store.remove("gone-lark", Date.now(), row, "completed");
		const result = await team.send("gone-lark", "are you there?");
		expect(result).toEqual({ error: expect.stringContaining(peerNext) });
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		expect(noticesAbout("gone-lark")).toEqual([]);
	}, 30_000);

	it("(e) hears once, without a wake, that a question was read but not answered when the peer ended", async () => {
		const { store, row } = peer("deep-otter");
		const id = sentId(await team.send("deep-otter", "which branch should I use?", { replyRequired: true }));
		store.ack("deep-otter", [id]);
		store.remove("deep-otter", Date.now(), row, "failed");
		const notice = await oneNotice("deep-otter");
		expect(notice.text).toContain(`#${id}`);
		expect(notice.text).toContain("deep-otter");
		expect(notice.text).toContain(peerNext);
	}, 30_000);

	it("points to a killed child's report and how to resume or restart it", async () => {
		const worker = await processPeer("kid-falcon", team.id);
		const id = sentId(await team.send("kid-falcon", "also cover the edge case"));
		await kill(worker);
		team.rememberFinished("kid-falcon", "Its report reached you.");
		const notice = await oneNotice("kid-falcon");
		expect(notice.text).toContain(`#${id}`);
		expect(notice.text).toContain(childNext("kid-falcon", true));
	}, 40_000);
});
