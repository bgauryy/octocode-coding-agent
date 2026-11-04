import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const SOURCE_RESOLVER = path.join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const WORKER = path.join(import.meta.dirname, "lifecycle-child-worker.ts");
let root: string;
let team: Team;
let host: ReturnType<typeof fakeHost>;
let peers: TeamStore[] = [];
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
/** What the session was told about peers: `<agent> ended: <reason>` lines, with whether each woke an idle agent. */
const told = () =>
	host.sent
		.filter((entry) => /ended: /.test(String(entry.message.content)))
		.map((entry) => [String(entry.message.content), entry.options.triggerTurn] as const);
const sweep = () => (team as unknown as { database: { store(): TeamStore } }).database.store().sweep(Date.now());

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-peer-left-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	host = fakeHost();
	team = new Team(host.api, { OCTOCODE_AGENT_DB: path.join(root, "agent.db") });
	// Only a session with a file writes the presence events the notice follows.
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

describe("the peer-left notice", () => {
	it("tells an agent that a peer it sent mail to ended, as an FYI that starts no turn", async () => {
		const { store, row } = peer("quiet-lynx");
		await team.send("quiet-lynx", "fyi: the build is green", { replyRequired: false });
		store.remove("quiet-lynx", Date.now(), row, "completed");
		await vi.waitFor(() => expect(told()).toEqual([["quiet-lynx ended: completed", false]]));
	});

	it("tells it for a peer that wrote to it, too", async () => {
		const { store, row } = peer("chatty-wren");
		store.send("chatty-wren", [team.id!], "hello", { replyRequired: false });
		store.remove("chatty-wren", Date.now(), row, "left");
		await vi.waitFor(() => expect(told()).toEqual([["chatty-wren ended: left", false]]));
	});

	it("wakes the agent when a peer ended with its question unanswered", async () => {
		const { store, row } = peer("deep-heron");
		await team.send("deep-heron", "which branch should I use?", { replyRequired: true });
		store.remove("deep-heron", Date.now(), row, "failed");
		await vi.waitFor(() => expect(told()).toEqual([["deep-heron ended: failed", true]]));
	});

	it("does not wake it once the peer had answered", async () => {
		const { store, row } = peer("kind-otter");
		const asked = await team.send("kind-otter", "which branch?", { replyRequired: true });
		store.send("kind-otter", [team.id!], "main", { replyRequired: false, replyTo: asked.id });
		store.remove("kind-otter", Date.now(), row, "completed");
		await vi.waitFor(() => expect(told()).toEqual([["kind-otter ended: completed", false]]));
	});

	it("says nothing about a peer it never corresponded with, nor about its own child", () => {
		const stranger = peer("stranger-ibis");
		stranger.store.remove("stranger-ibis", Date.now(), stranger.row, "completed");
		const child = peer("own-child", { parentId: team.id! });
		child.store.send("own-child", [team.id!], "question", { replyRequired: true });
		child.store.remove("own-child", Date.now(), child.row, "completed");
		expect(told()).toEqual([]);
	});

	it("tells it when a peer is killed with -9 and swept: a notice and a wake for its open question", async () => {
		const worker = spawn(
			process.execPath,
			["--import", SOURCE_RESOLVER, WORKER, root, path.join(root, "agent.db"), "far-ibis"],
			{
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		children.push(worker);
		const name = await new Promise<string>((resolve, reject) => {
			worker.stdout!.on(
				"data",
				(chunk: Buffer) => /joined (\S+)/.exec(String(chunk)) && resolve(/joined (\S+)/.exec(String(chunk))![1]),
			);
			worker.once("exit", (code) => reject(new Error(`The worker exited with ${code} before it joined.`)));
		});
		await team.send(name, "are you still working on it?", { replyRequired: true });
		const gone = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
		worker.kill("SIGKILL");
		await gone;
		sweep();
		await vi.waitFor(() => expect(told()).toEqual([[`${name} ended: crashed`, true]]), { timeout: 10_000 });
	}, 60_000);
});
