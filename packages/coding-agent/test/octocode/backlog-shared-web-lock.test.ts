import { fork, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Backlog, BacklogWeb } from "../../src/octocode/backlog/context.ts";
import { sharedWorkspaceWeb } from "../../src/octocode/backlog/shared-web.ts";
import { registryPaths } from "../../src/octocode/backlog/shared-web-registry.ts";
import { acquireRegistryLock } from "../../src/octocode/backlog/shared-web-lock.ts";

const childScript = fileURLToPath(new URL("./backlog-shared-lock-child.ts", import.meta.url));

/** The lock directory proper-lockfile creates for `lockPath`, and the owner file that sits beside it. */
function seedLock(lockPath: string, owner: object | undefined): void {
	fs.mkdirSync(`${lockPath}.lock`, { recursive: true });
	if (owner) fs.writeFileSync(`${lockPath}.owner`, JSON.stringify(owner));
}

function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	return Number(result.stdout);
}

function lockedChild(lockPath: string): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = fork(childScript, [], {
			env: { ...process.env, SHARED_LOCK_PATH: lockPath },
			execArgv: ["--experimental-strip-types", "--no-warnings"],
		});
		child.once("message", (message) => (message === "locked" ? resolve(child) : reject(new Error("unexpected"))));
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
	});
}

describe("registry lock recovery after a crashed owner", () => {
	let dir: string;
	let lockPath: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-lock-"));
		lockPath = path.join(dir, ".entry.lock");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("takes over a fresh lock whose recorded owner process is gone", async () => {
		seedLock(lockPath, { pid: deadPid() });
		const started = Date.now();
		const release = await acquireRegistryLock(lockPath);
		expect(Date.now() - started).toBeLessThan(1000);
		await release();
		expect(fs.existsSync(`${lockPath}.lock`)).toBe(false);
		expect(fs.existsSync(`${lockPath}.owner`)).toBe(false);
	});

	it("does not break a lock that a new owner took over after the dead owner's directory went stale", async () => {
		// The dead owner recorded its directory; the lock directory now present is a different one (a stale takeover
		// whose owner has not written its owner file yet).
		const old = path.join(dir, "old-lock-dir");
		fs.mkdirSync(old);
		const oldId = String(fs.statSync(old, { bigint: true }).ino);
		seedLock(lockPath, { pid: deadPid(), dir: oldId });
		await expect(acquireRegistryLock(lockPath, 300)).rejects.toMatchObject({ code: "ELOCKED" });
		expect(fs.existsSync(`${lockPath}.lock`)).toBe(true);
	});

	it("records the lock directory with the owner, and breaks it once that owner is gone", async () => {
		const release = await acquireRegistryLock(lockPath);
		const owner = JSON.parse(fs.readFileSync(`${lockPath}.owner`, "utf8")) as { dir?: string };
		expect(owner.dir).toBe(String(fs.statSync(`${lockPath}.lock`, { bigint: true }).ino));
		fs.writeFileSync(`${lockPath}.owner`, JSON.stringify({ ...owner, pid: deadPid() }));
		const next = await acquireRegistryLock(lockPath, 1000);
		await next();
		await release().catch(() => undefined);
	});

	it("keeps waiting for a live owner and gets the lock once it releases", async () => {
		const release = await acquireRegistryLock(lockPath);
		await expect(acquireRegistryLock(lockPath, 300)).rejects.toMatchObject({ code: "ELOCKED" });
		const waiting = acquireRegistryLock(lockPath, 5000);
		setTimeout(() => void release(), 200);
		const second = await waiting;
		await second();
	});

	it("never grants the lock to two takers when several break the same dead owner", async () => {
		seedLock(lockPath, { pid: deadPid() });
		let holders = 0;
		let overlap = false;
		await Promise.all(
			Array.from({ length: 8 }, async () => {
				const release = await acquireRegistryLock(lockPath, 10_000);
				if (++holders > 1) overlap = true;
				await new Promise((resolve) => setTimeout(resolve, 20));
				holders--;
				await release();
			}),
		);
		expect(overlap).toBe(false);
	});

	it("does not break a lock whose owner is unknown while it is fresh", async () => {
		seedLock(lockPath, undefined);
		await expect(acquireRegistryLock(lockPath, 300)).rejects.toMatchObject({ code: "ELOCKED" });
	});

	it("lets /web start right after the launcher holding the registry lock was killed", async () => {
		const backlog: Backlog = {
			store: { repo: "repo" } as Backlog["store"],
			actor: { id: "test" },
			session: "session-crash",
			repoName: "repo",
			repoRoot: dir,
		};
		const env = { ...process.env, OCTOCODE_AGENT_DB: path.join(dir, "db") };
		const { lock } = registryPaths(dir, "session-crash", env);
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		const child = await lockedChild(lock);
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));
		expect(fs.existsSync(`${lock}.lock`)).toBe(true);

		let starts = 0;
		const web = sharedWorkspaceWeb(async (): Promise<BacklogWeb> => {
			starts++;
			return { url: "http://127.0.0.1:1/#access=t", close: async () => undefined };
		}, env);
		const started = Date.now();
		const opened = await web({} as never, backlog, () => undefined);
		const waited = Date.now() - started;
		expect(starts).toBe(1);
		expect(waited).toBeLessThan(1000);
		await opened.close();
	});
});
