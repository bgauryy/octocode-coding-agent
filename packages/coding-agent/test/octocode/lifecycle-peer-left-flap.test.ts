import { withoutSourceHeader } from "../../src/octocode/shared/fence.ts";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let root: string;
let team: Team;
let host: ReturnType<typeof fakeHost>;
const stores: TeamStore[] = [];
const children: ChildProcess[] = [];
const dbFile = () => path.join(root, "agent.db");

const member = (id: string, pid: number, joinedAt: number): Member => ({
	id,
	role: "researcher",
	pid,
	status: "idle",
	joinedAt,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});
/** The `<agent> ended: <reason>` lines the session was told. */
const told = () =>
	host.sent.map((entry) => withoutSourceHeader(String(entry.message.content))).filter((text) => /ended: /.test(text));

function startTeam(): void {
	host = fakeHost();
	team = new Team(host.api, { OCTOCODE_AGENT_DB: dbFile() });
	const ctx = fakeCtx({ cwd: root, hasUI: false });
	(ctx.sessionManager as { getSessionFile(): string }).getSessionFile = () => path.join(root, "session.jsonl");
	team.start(ctx);
	team.join();
}

function peerStore(id: string): TeamStore {
	const store = TeamStore.open(root, dbFile(), {});
	store.lifecycle = { activationId: `a-${id}`, sessionId: `s-${id}` };
	stores.push(store);
	return store;
}

/** A live process that is not this one: the pid a peer's row names. */
function livePid(): number {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	children.push(child);
	return child.pid!;
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-peer-flap-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	startTeam();
});
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const store of stores.splice(0)) store.close();
	team.stop();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the peer-left notice and a peer that is still running", () => {
	it("does not say a peer crashed while its process runs, however often its row is retired and registered again", async () => {
		const joinedAt = Date.now();
		const pid = livePid();
		const store = peerStore("flappy-lynx");
		const row = member("flappy-lynx", pid, joinedAt);
		store.join(row);
		store.send("flappy-lynx", [team.id!], "hello", { replyRequired: false });
		// A transient wrong verdict retires the live row three times; the next heartbeat registers it again each time.
		for (let round = 0; round < 3; round++) {
			store.remove("flappy-lynx", Date.now(), row, "crashed");
			store.join(row);
		}
		// The same process then leaves for real.
		store.remove("flappy-lynx", Date.now(), row, "completed");
		await vi.waitFor(() => expect(told()).toContain("flappy-lynx ended: completed"));
		expect(told()).toEqual(["flappy-lynx ended: completed"]);
	});

	it("still says a peer crashed once its process is gone", async () => {
		const pid = livePid();
		const store = peerStore("gone-wren");
		const row = member("gone-wren", pid, Date.now());
		store.join(row);
		store.send("gone-wren", [team.id!], "hello", { replyRequired: false });
		const child = children[children.length - 1];
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
		store.remove("gone-wren", Date.now(), row, "crashed");
		await vi.waitFor(() => expect(told()).toEqual(["gone-wren ended: crashed"]));
	});

	it("tells once about a peer that ends after this agent reloaded its session", async () => {
		const store = peerStore("late-heron");
		const pid = livePid();
		const row = member("late-heron", pid, Date.now());
		store.join(row);
		store.send("late-heron", [team.id!], "hello", { replyRequired: false });
		// A reload: the session stops, then starts again on the same database and name.
		team.stop();
		startTeam();
		store.send("late-heron", [team.id!], "hello again", { replyRequired: false });
		store.remove("late-heron", Date.now(), row, "completed");
		await vi.waitFor(() => expect(told()).toEqual(["late-heron ended: completed"]));
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(told()).toEqual(["late-heron ended: completed"]);
	});
});
