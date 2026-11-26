import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { BUSY_MS } from "../../src/octocode/team/store/limits.ts";
import { patiently } from "../../src/octocode/team/store/patient.ts";
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

/** The file holding `cwd`'s team rows under the machine file `file`: the workspace file, or `file` while they are off. */
const workspaceFile = (cwd: string, file: string): string =>
	workspaceDb(cwd, { ...process.env, OCTOCODE_AGENT_DB: file }).agent.file;

afterEach(() => closeSharedAgentDb());

describe("team store on a busy database", () => {
	it("opens without waiting for housekeeping while another process holds the write lock, and prunes at the next heartbeat", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const file = path.join(tmp(), "team.sqlite");
		const initial = TeamStore.open(cwd, file);
		const workspaceId = initial.workspaceId;
		initial.close();
		// Another process mid-write: an expired lease is left for the prune to remove.
		const other = new DatabaseSync(workspaceFile(cwd, file));
		other.exec("PRAGMA busy_timeout=5000");
		other
			.prepare(
				"INSERT INTO leases (workspace_id, path, path_key, kind, owner, reason, acquired_at, expires_at) VALUES (?, 'a.ts', 'a.ts', 'file', 'gone', '', 0, 1)",
			)
			.run(workspaceId);
		other.exec("BEGIN IMMEDIATE");
		const started = Date.now();
		let store: TeamStore | undefined;
		try {
			store = TeamStore.open(cwd, file);
			// Well under the 5 s a write the agent asked for would wait.
			expect(Date.now() - started).toBeLessThan(2_000);
		} finally {
			other.exec("COMMIT");
		}
		try {
			expect(other.prepare("SELECT COUNT(*) AS n FROM leases WHERE owner = 'gone'").get()).toEqual({ n: 1 });
			expect(store.save(member("inky"))).toBe(true);
			expect(other.prepare("SELECT COUNT(*) AS n FROM leases WHERE owner = 'gone'").get()).toEqual({ n: 0 });
		} finally {
			store.close();
			other.close();
		}
	});

	it("never waits inside SQLite for a background write: the ticker's heartbeat fails at once and is retried later", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const file = path.join(tmp(), "team.sqlite");
		const store = TeamStore.open(cwd, file);
		const other = new DatabaseSync(workspaceFile(cwd, file));
		try {
			store.save(member("inky"));
			other.exec("BEGIN IMMEDIATE");
			const started = performance.now();
			expect(() => store.quick(() => store.save(member("inky")))).toThrow(/locked|busy/i);
			// Elapsed time is the contract here (no wait inside SQLite), so it is compared with the wait a write the agent asked
			// for would take (BUSY_MS), with a wide margin for a loaded machine, instead of a fixed count of milliseconds.
			expect(performance.now() - started).toBeLessThan(BUSY_MS / 10);
			other.exec("COMMIT");
			expect(store.quick(() => store.save(member("inky")))).toBe(true);
		} finally {
			store.close();
			other.close();
		}
	});

	it("retries a write the agent asked for off this thread's clock, as one transaction, until the database frees", async () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const file = path.join(tmp(), "team.sqlite");
		const store = TeamStore.open(cwd, file);
		const other = new DatabaseSync(workspaceFile(cwd, file));
		try {
			store.save(member("inky"));
			other.exec("BEGIN IMMEDIATE");
			setTimeout(() => other.exec("COMMIT"), 300);
			let ticks = 0;
			const ticker = setInterval(() => ticks++, 10);
			const started = performance.now();
			const target = path.join(store.workspace, "a.ts");
			const result = await patiently(store, () => store.lock("inky", [{ path: target, kind: "file", reason: "edit" }]));
			clearInterval(ticker);
			expect(result.ok).toBe(true);
			expect(performance.now() - started).toBeGreaterThan(250);
			// The screen's timers kept running while the lock was held: no wait happened on this thread.
			expect(ticks).toBeGreaterThan(10);
			expect(store.leases().map((lease) => lease.owner)).toEqual(["inky"]);
		} finally {
			store.close();
			other.close();
		}
	});

	it("leaves no abort listener behind on the caller's signal, however many pauses a busy write took", async () => {
		let attempts = 0;
		const busyStore = {
			quick<T>(work: () => T): T {
				if (++attempts <= 6) throw Object.assign(new Error("database is locked"), { errcode: 5 });
				return work();
			},
		};
		const abort = new AbortController();
		let listening = 0;
		const add = abort.signal.addEventListener.bind(abort.signal);
		const remove = abort.signal.removeEventListener.bind(abort.signal);
		abort.signal.addEventListener = ((...args: Parameters<typeof add>) => {
			listening++;
			add(...args);
		}) as typeof add;
		abort.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
			listening--;
			remove(...args);
		}) as typeof remove;
		await expect(patiently(busyStore, () => "saved", abort.signal)).resolves.toBe("saved");
		expect(attempts).toBe(7);
		expect(listening).toBe(0);
	});

	it("gives up a write the agent asked for when the run is aborted while the database is held", async () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const file = path.join(tmp(), "team.sqlite");
		const store = TeamStore.open(cwd, file);
		const other = new DatabaseSync(workspaceFile(cwd, file));
		try {
			other.exec("BEGIN IMMEDIATE");
			const abort = new AbortController();
			setTimeout(() => abort.abort(new Error("stopped")), 50);
			await expect(patiently(store, () => store.save(member("inky")), abort.signal)).rejects.toThrow("stopped");
		} finally {
			other.exec("COMMIT");
			store.close();
			other.close();
		}
	});
});
