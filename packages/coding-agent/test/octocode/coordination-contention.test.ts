import fs from "node:fs";
import path from "node:path";
import type { ApplicationCommand } from "@octocodeai/octocode-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { holdWrite } from "../../../db/test/hold-write.ts";
import type { AgentDb } from "../../../db/src/api.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { ApplicationCommands } from "../../src/octocode/workspace/application-commands.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registerFixtureWorkspace } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** How long the other process keeps the write lock: long enough that a blocked thread would show. */
const HOLD_MS = 300;
/** The longest pause between this thread's timer ticks while the lock is held elsewhere. */
const MAX_STALL_MS = 50;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * Holds `file`'s write lock in another process while `work` runs, releasing it after `HOLD_MS` from a timer of this
 * thread (which only fires if the thread is free); `work`'s result, and the longest gap between this thread's ticks
 * until the release.
 */
async function underForeignLock<T>(file: string, work: () => Promise<T>): Promise<{ result: T; stallMs: number }> {
	const holder = await holdWrite(file);
	cleanup.push(() => holder.close());
	let last = performance.now();
	let stallMs = 0;
	let released = false;
	const ticks = setInterval(() => {
		const now = performance.now();
		if (!released) stallMs = Math.max(stallMs, now - last);
		last = now;
	}, 5);
	const release = setTimeout(() => {
		stallMs = Math.max(stallMs, performance.now() - last);
		released = true;
		holder.release();
	}, HOLD_MS);
	try {
		const result = await work();
		expect(released).toBe(true);
		return { result, stallMs };
	} finally {
		clearInterval(ticks);
		clearTimeout(release);
	}
}

function receiptDb(): { file: string; open: () => AgentDb } {
	const file = path.join(tmp(), "agent.db");
	const open = () => {
		const db = openAgentDb(file);
		cleanup.push(() => db.close());
		return db;
	};
	registerFixtureWorkspace(open(), "repo");
	return { file, open };
}

const command = (sessionId: string): ApplicationCommand => ({
	id: "request-one",
	sessionId,
	action: "prompt",
	text: "Review the implementation",
});

describe("application receipts while another process holds the database", () => {
	it("wait without stalling this thread, and two connections record one receipt", async () => {
		const { file, open } = receiptDb();
		const first = new ApplicationCommands(open(), "repo");
		const second = new ApplicationCommands(open(), "repo");
		const { result, stallMs } = await underForeignLock(file, () =>
			Promise.all([first.begin(command("session-one")), second.begin(command("session-one"))]),
		);
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(result.filter((recorded) => recorded.fresh)).toHaveLength(1);
		// The fresh receipt is the new one; the other reads it back as stored, with its recorded message.
		expect(result.find((recorded) => recorded.fresh)?.receipt).toEqual({ id: "request-one", status: "accepted" });
		expect(result.find((recorded) => !recorded.fresh)?.receipt).toMatchObject({
			id: "request-one",
			status: "accepted",
		});

		const { stallMs: finishStall } = await underForeignLock(file, () =>
			(result[0].fresh ? first : second).finish("request-one", "completed"),
		);
		expect(finishStall).toBeLessThan(MAX_STALL_MS);
		expect((await new ApplicationCommands(open(), "repo").begin(command("session-one"))).receipt.status).toBe(
			"completed",
		);
	});

	it("admit a command sent twice at once exactly once", async () => {
		const { file, open } = receiptDb();
		const prompts: string[] = [];
		const session = {
			sessionId: "session-two",
			messages: [],
			isStreaming: false,
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
			subscribe: () => () => {},
			async prompt(text: string) {
				prompts.push(text);
			},
			async abort() {},
		} as unknown as AgentSession;
		const service = getApplicationPort(session);
		cleanup.push(() => service.dispose());
		const receipts = new ApplicationCommands(open(), "repo");
		service.setReceiptStore(receipts);
		const { result, stallMs } = await underForeignLock(file, () =>
			Promise.all([service.execute(command("session-two")), service.execute(command("session-two"))]),
		);
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(result).toEqual([
			{ id: "request-one", status: "accepted" },
			{ id: "request-one", status: "accepted" },
		]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(prompts).toEqual(["Review the implementation"]);
	});
});

describe("child reservations while another process holds the database", () => {
	it("wait without stalling this thread, and two children never both hold one path", async () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const file = path.join(tmp(), "team.sqlite");
		const store = TeamStore.open(cwd, file, {});
		cleanup.push(() => store.close());
		const team = new Team(fakeHost().api, { OCTOCODE_AGENT_DB: file });
		team.start(fakeCtx({ cwd, hasUI: true, idle: true }));
		cleanup.push(() => team.stop());
		team.join();

		const { result, stallMs } = await underForeignLock(file, () =>
			Promise.all([
				team.childLeases.reserve({ id: "kid-one", role: "general", goal: "edit a" }, ["a.ts"]),
				team.childLeases.reserve({ id: "kid-two", role: "general", goal: "edit a too" }, ["a.ts"]),
			]),
		);
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(result.filter((outcome) => outcome.ok)).toHaveLength(1);
		const winner = result[0].ok ? "kid-one" : "kid-two";
		const refused = result.find((outcome) => !outcome.ok);
		expect(refused).toMatchObject({ ok: false, conflicts: [{ path: "a.ts", heldBy: { owner: winner } }] });
		expect(store.leases().map((lease) => `${lease.owner}:${lease.path}`)).toEqual([`${winner}:a.ts`]);
	});

	it("stop waiting when the launch is cancelled, holding nothing", async () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const file = path.join(tmp(), "team.sqlite");
		const store = TeamStore.open(cwd, file, {});
		cleanup.push(() => store.close());
		const team = new Team(fakeHost().api, { OCTOCODE_AGENT_DB: file });
		team.start(fakeCtx({ cwd, hasUI: true, idle: true }));
		cleanup.push(() => team.stop());
		team.join();
		const holder = await holdWrite(file);
		cleanup.push(() => holder.close());
		const cancel = new AbortController();
		const reserving = team.childLeases.reserve(
			{ id: "kid-one", role: "general", goal: "edit a" },
			["a.ts"],
			cancel.signal,
		);
		setTimeout(() => cancel.abort(), 30);
		await expect(reserving).rejects.toThrow();
		await holder.close();
		expect(store.leases()).toEqual([]);
	});
});
