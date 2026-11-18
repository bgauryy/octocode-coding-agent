import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { processStartAsync } from "../packages/common/src/process-start.ts";
import {
	acquireRunLock,
	RUN_LOCK_ENV,
	RUN_LOCK_HELD_ENV,
	readRunLockOwner,
	runLockStatus,
	type RunLockOwner,
} from "./full-run-lock.ts";

let root: string;
let dir: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "run-lock-"));
	dir = path.join(root, "locks", "full-run");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const options = (env: NodeJS.ProcessEnv = {}, lines: string[] = []) => ({
	label: "vitest in test",
	dir,
	env,
	pollMs: 10,
	log: (line: string) => lines.push(line),
});

/** Record `pid` as the holder, as a run in another process would. */
function holdAs(pid: number, started: string | undefined): void {
	fs.mkdirSync(dir, { recursive: true });
	const owner: RunLockOwner = {
		token: "other",
		pid,
		started,
		label: "yarn test elsewhere",
		cwd: "/elsewhere",
		since: "t",
	};
	fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
}

describe("full-run lock", () => {
	it("records its holder, passes the hold to child processes and removes the lock on release", async () => {
		const env: NodeJS.ProcessEnv = { OCTOCODE_SESSION_ID: "s1" };
		const release = await acquireRunLock(options(env));
		assert.deepEqual(
			{ ...readRunLockOwner(dir), token: "x", since: "x", started: "x" },
			{
				token: "x",
				since: "x",
				started: "x",
				pid: process.pid,
				label: "vitest in test",
				session: "s1",
				cwd: process.cwd(),
			},
		);
		assert.equal(env[RUN_LOCK_HELD_ENV], readRunLockOwner(dir)?.token);
		// A suite the holder starts inherits the hold and does not wait for its own parent.
		await (
			await acquireRunLock(options({ ...env }))
		)();
		assert.ok(fs.existsSync(dir));
		release();
		assert.equal(fs.existsSync(dir), false);
		assert.equal(env[RUN_LOCK_HELD_ENV], undefined);
	});

	it("runs a second full run only after the first releases, naming the holder while it waits", async () => {
		const first = await acquireRunLock(options({ OCTOCODE_SESSION_ID: "first" }));
		const lines: string[] = [];
		let took = false;
		const second = acquireRunLock(options({}, lines)).then((release) => {
			took = true;
			return release;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(took, false);
		assert.match(
			lines[0] ?? "",
			/Waiting for the full run already going on this host: vitest in test \(pid \d+, session first\)/,
		);
		first();
		const release = await second;
		assert.equal(readRunLockOwner(dir)?.session, undefined);
		assert.match(lines.at(-1) ?? "", /^Full-run lock taken after \d+s\.$/);
		release();
	});

	it("takes over at once from a holder that exited", async () => {
		const child = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => child.once("exit", resolve));
		holdAs(child.pid!, undefined);
		const release = await acquireRunLock(options());
		assert.equal(readRunLockOwner(dir)?.pid, process.pid);
		release();
	});

	it("takes over from a pid that now names a later process, and waits for a live holder", async () => {
		const child = spawn("sleep", ["30"]);
		try {
			const started = (await processStartAsync(child.pid!))?.started;
			assert.ok(started);
			holdAs(child.pid!, String(Number(started) - 100));
			const reused = await acquireRunLock(options());
			reused();

			holdAs(child.pid!, started);
			const lines: string[] = [];
			const waiting = acquireRunLock(options({}, lines));
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(readRunLockOwner(dir)?.token, "other");
			assert.match(lines[0] ?? "", /yarn test elsewhere \(pid \d+\) in \/elsewhere/);
			child.kill();
			(await waiting)();
		} finally {
			child.kill();
		}
	});

	it("stops waiting when cancelled and leaves the holder's lock alone", async () => {
		const first = await acquireRunLock(options());
		const controller = new AbortController();
		const waiting = acquireRunLock({ ...options(), signal: controller.signal });
		setTimeout(() => controller.abort(), 30);
		await assert.rejects(waiting, { name: "AbortError" });
		assert.equal(readRunLockOwner(dir)?.pid, process.pid);
		first();
	});

	it(`takes no lock when ${RUN_LOCK_ENV}=off`, async () => {
		const release = await acquireRunLock(options({ [RUN_LOCK_ENV]: "off" }));
		assert.equal(fs.existsSync(dir), false);
		release();
	});
});

describe("full-run lock status", () => {
	it("reports a lock free when none exists", async () => {
		assert.deepEqual(await runLockStatus(dir), { free: true });
	});

	it("reports a dead holder's lock free and removes it", async () => {
		const child = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => child.once("exit", resolve));
		holdAs(child.pid, undefined);
		assert.deepEqual(await runLockStatus(dir), { free: true });
		assert.equal(fs.existsSync(dir), false);
	});

	it("reports a live holder's lock held and leaves it", async () => {
		const child = spawn("sleep", ["30"]);
		try {
			holdAs(child.pid, (await processStartAsync(child.pid))?.started);
			const status = await runLockStatus(dir);
			assert.equal(status.free, false);
			assert.match(status.free ? "" : status.holder, /yarn test elsewhere \(pid \d+\)/);
			assert.equal(readRunLockOwner(dir)?.token, "other");
		} finally {
			child.kill();
		}
	});
});
