import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiDir, ensurePrivateDir } from "../../src/octocode/api/registry.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { failure, Owned } from "./comm-matrix-peers.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { makeRepo, sh } from "./worktree-fixture.ts";

/**
 * Every route a message can take between agents ends in one of two states: delivered (the recipient holds it) or a
 * loud, specific failure the sender sees (refused, departed, overloaded, unread when its receiver exited). Team mail
 * routes run as sessions on one team database; the socket routes between processes run as real processes.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("team mail routes", () => {
	let cwd: string;
	let db: string;
	let store: TeamStore;
	const teams: Team[] = [];
	const closers: Array<() => Promise<void>> = [];
	const open = (env: Record<string, string> = {}, at = cwd): Team => {
		const team = new Team(fakeHost().api, { OCTOCODE_AGENT_DB: db, ...env });
		team.start(fakeCtx({ cwd: at, hasUI: false, idle: false }));
		teams.push(team);
		return team;
	};
	const sentId = (result: Awaited<ReturnType<Team["send"]>>): number => {
		if ("error" in result) throw new Error(result.error);
		return result.id;
	};
	const holds = (recipient: string, id: number) =>
		expect(store.pending(recipient).map((message) => message.id)).toContain(id);

	beforeEach(() => {
		cwd = tmp("comm-matrix-team-");
		fs.mkdirSync(path.join(cwd, ".git"));
		db = path.join(tmp("comm-matrix-db-"), "team.sqlite");
		store = TeamStore.open(cwd, db);
	});
	afterEach(async () => {
		for (const close of closers.splice(0)) await close();
		for (const team of teams.splice(0)) team.stop();
		store.close();
	});

	it("parent ↔ child: delivered both ways; a child that left is refused at send time", async () => {
		const parent = open();
		const parentId = parent.join().id;
		const child = open({ OCTOCODE_AGENT_ID: "kid-a", OCTOCODE_PARENT_ID: parentId });
		child.join();
		holds("kid-a", sentId(await parent.send("kid-a", "down to the child")));
		holds(parentId, sentId(await child.send("parent", "up to the parent")));
		child.leave("completed");
		expect(await parent.send("kid-a", "after it left")).toEqual({ error: expect.any(String) });
	});

	it("sibling children: one child's message reaches the other", async () => {
		const parent = open();
		const parentId = parent.join().id;
		const a = open({ OCTOCODE_AGENT_ID: "kid-a", OCTOCODE_PARENT_ID: parentId });
		a.join();
		const b = open({ OCTOCODE_AGENT_ID: "kid-b", OCTOCODE_PARENT_ID: parentId });
		b.join();
		holds("kid-b", sentId(await a.send("kid-b", "sibling finding")));
		holds("kid-a", sentId(await b.send("kid-a", "sibling answer")));
	});

	it("isolated child in a linked worktree: delivered both ways over the shared team database", async () => {
		const repo = makeRepo();
		closers.push(async () => repo.cleanup());
		const linked = path.join(repo.root, ".octocode", "agent", "worktrees", "kid-iso");
		sh(repo.root, "worktree", "add", "-q", "-b", "kid-iso", linked);
		const parent = open({}, repo.root);
		const parentId = parent.join().id;
		const child = open({ OCTOCODE_AGENT_ID: "kid-iso", OCTOCODE_PARENT_ID: parentId }, linked);
		child.join();
		holds("kid-iso", sentId(await parent.send("kid-iso", "into the worktree")));
		holds(parentId, sentId(await child.send("parent", "out of the worktree")));
	});

	it("external runner: mail waits in its pull inbox; a wake it cannot honour is refused", async () => {
		const parent = open();
		parent.join();
		const bridge = await parent.runnerBridge({ id: "ext-runner", runner: "claude-code", cwd });
		closers.push(() => bridge.close());
		const sent = await parent.send("ext-runner", "for the runner");
		expect(sent).toMatchObject({ delivery: { "ext-runner": "pull" } });
		holds("ext-runner", sentId(sent));
		expect(await parent.send("ext-runner", "wake up", { wake: true })).toEqual({ error: expect.any(String) });
	});

	it("user → agent: delivered as the user's message", async () => {
		const parent = open();
		const parentId = parent.join().id;
		const child = open({ OCTOCODE_AGENT_ID: "kid-u", OCTOCODE_PARENT_ID: parentId });
		child.join();
		const id = sentId(await parent.send("kid-u", "from the user", { from: "user" }));
		expect(store.pending("kid-u")).toEqual(expect.arrayContaining([expect.objectContaining({ id, from: "user" })]));
	});
});

describe.runIf(process.platform !== "win32")("socket routes between processes", () => {
	let owned: Owned;
	let cwd: string;
	beforeEach(() => {
		vi.stubEnv("OCTOCODE_HOME", tmp("comm-matrix-home-"));
		ensurePrivateDir(apiDir());
		cwd = fs.realpathSync(tmp("comm-matrix-cwd-"));
		owned = new Owned();
	});
	afterEach(async () => {
		await owned.release();
		vi.unstubAllEnvs();
	});

	it("coordinator ↔ coordinator: delivered; a recipient that exited is refused as not sent", async () => {
		const peer = await owned.peer("oc-peer", cwd);
		const { send } = owned.sender(cwd);
		await expect(send(peer.name, "over the socket")).resolves.toMatchObject({ details: { to: [peer.name] } });
		await vi.waitFor(() => expect(peer.received).toEqual(["over the socket"]));
		await peer.kill();
		expect(await failure(send(peer.name, "after it exited"))).toMatchObject({ execution: "not-sent" });
	}, 30_000);

	it("an overloaded recipient refuses before reading: not sent, and the same send works once slots free", async () => {
		const peer = await owned.peer("oc-busy", cwd);
		const { send } = owned.sender(cwd);
		const held = await owned.hold(peer.socket, 16);
		expect(await failure(send(peer.name, "while saturated"))).toMatchObject({
			execution: "not-sent",
			reason: "overloaded",
			retryAfterMs: expect.any(Number),
		});
		await owned.free(held);
		// The server frees a slot when it sees the close; until then a refusal is still a safe non-delivery.
		await vi.waitFor(
			async () => {
				const outcome = await send(peer.name, "after slots freed").catch((error: unknown) => error);
				if (outcome instanceof Error) expect(outcome).toMatchObject({ execution: "not-sent", reason: "overloaded" });
				expect(outcome).toMatchObject({ details: { to: [peer.name] } });
			},
			{ interval: 100 },
		);
		await vi.waitFor(() => expect(peer.received).toEqual(["after slots freed"]));
	}, 30_000);

	it("a recipient that exits with the message still queued: the sender hears once, quietly", async () => {
		const peer = await owned.peer("oc-queue", cwd, "queue");
		const { send, quiet, notice } = owned.sender(cwd);
		await expect(send(peer.name, "queued and never read")).resolves.toMatchObject({ details: { queued: "steer" } });
		await peer.kill();
		await vi.waitFor(() => expect(quiet).toHaveBeenCalled(), { interval: 50 });
		await wait(2_500);
		expect(quiet).toHaveBeenCalledTimes(1);
		expect(quiet.mock.calls[0][0]).toContain(peer.name);
		expect(quiet.mock.calls[0][0]).toContain("queued and never read");
		expect(notice).not.toHaveBeenCalled();
	}, 30_000);

	it("a recipient that read its queue before exiting: no notice", async () => {
		const peer = await owned.peer("oc-reader", cwd, "queue-read");
		const { send, quiet, notice } = owned.sender(cwd);
		await expect(send(peer.name, "queued and read")).resolves.toMatchObject({ details: { queued: "steer" } });
		await wait(2_500);
		await peer.kill();
		await wait(2_500);
		expect(quiet).not.toHaveBeenCalled();
		expect(notice).not.toHaveBeenCalled();
	}, 30_000);

	it("main ↔ linked worktree session: `coordinator` reaches the main checkout; none running is refused", async () => {
		const repo = makeRepo();
		try {
			const linked = path.join(repo.root, ".octocode", "agent", "worktrees", "feature");
			sh(repo.root, "worktree", "add", "-q", "-b", "feature", linked);
			const main = await owned.peer("oc-main", repo.root);
			const { send } = owned.sender(linked);
			await expect(send("coordinator", "please merge feature")).resolves.toMatchObject({
				details: { to: [main.name] },
			});
			await vi.waitFor(() => expect(main.received).toEqual(["please merge feature"]));
			await main.kill();
			expect(await failure(send("coordinator", "anyone there?"))).toMatchObject({ execution: "not-sent" });
		} finally {
			repo.cleanup();
		}
	}, 30_000);
});
