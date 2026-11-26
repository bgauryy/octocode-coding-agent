import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { isBusy } from "../../../db/src/api.ts";
import { DatabaseFollower } from "../../src/octocode/shared/database-follower.ts";
import { Activity } from "../../src/octocode/team/session/activity.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { openWorkspaceDb } from "../../src/storage/workspace-database.ts";
import { tmp } from "./helpers.ts";

const member = (id: string): Member => ({
	id,
	role: id,
	pid: process.pid,
	status: "idle",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

afterEach(() => vi.useRealTimers());

describe("a timer tick that meets another process's write lock", () => {
	it("skips the heartbeat at once, keeps the change pending, and writes it on the next tick", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const file = path.join(tmp(), "team.sqlite");
		const store = TeamStore.open(cwd, file);
		const machine = openAgentDb(file);
		const rows = openWorkspaceDb(machine, cwd).agent;
		const other = rows.db;
		const me = member("inky");
		store.save(me);
		const activity = new Activity({
			me: () => me,
			db: () => store,
			held: { holding: false, lost: () => [] },
			mail: { notice: vi.fn() },
			route: () => undefined,
			renewChildren: vi.fn(),
		});
		try {
			activity.update((row) => {
				row.status = "working";
			}, true);
			other.exec("BEGIN IMMEDIATE");
			expect(() => store.quick(() => activity.heartbeat(store))).toThrow(/locked|busy/i);
			// The throw comes while the lock is still held: a wait of BUSY_MS would outlast this test's own timeout.
			other.exec("COMMIT");
			expect(store.list().find((row) => row.id === "inky")?.status).toBe("idle");
			// The next tick writes the status the locked one could not.
			expect(store.quick(() => activity.heartbeat(store))).toBe(true);
			expect(store.list().find((row) => row.id === "inky")?.status).toBe("working");
		} finally {
			store.close();
			if (rows !== machine) rows.close();
			machine.close();
		}
	});

	it("asks a follower's listener again at the next tick after the busy error, and not after a quiet poke", () => {
		vi.useFakeTimers();
		let marker = 0;
		const follower = new DatabaseFollower(() => `${marker}`, isBusy);
		let locked = true;
		const poked = vi.fn(() => {
			if (locked) throw Object.assign(new Error("database is locked"), { errcode: 5 });
		});
		const stop = follower.subscribe(poked);
		try {
			marker = 1;
			vi.advanceTimersByTime(1_000);
			expect(poked).toHaveBeenCalledTimes(1);
			// The file did not move again, yet the busy poke is retried.
			vi.advanceTimersByTime(1_000);
			expect(poked).toHaveBeenCalledTimes(2);
			locked = false;
			vi.advanceTimersByTime(1_000);
			expect(poked).toHaveBeenCalledTimes(3);
			vi.advanceTimersByTime(3_000);
			expect(poked).toHaveBeenCalledTimes(3);
		} finally {
			stop();
		}
	});
});
