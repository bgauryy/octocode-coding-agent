import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

/** A session write under a lock another process holds must not stall this process's event loop. */

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../scripts/source-resolver.ts")).href;
const sharedFileUrl = pathToFileURL(resolve(__dirname, "../../src/core/session-manager/shared-file.ts")).href;

let dir: string;
let session: SessionManager;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-lock-loop-"));
	session = SessionManager.create(dir, dir);
	session.appendMessage(userMsg("hello"));
	session.appendMessage(assistantMsg("hi"));
	file = session.getSessionFile()!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Starts a child holding the lock for `holdMs`; resolves once it holds it. */
async function holdLockFor(holdMs: number): Promise<() => Promise<void>> {
	const script = join(dir, "hold.mjs");
	writeFileSync(
		script,
		`const { lockSessionFile } = await import(${JSON.stringify(sharedFileUrl)});
const release = lockSessionFile(process.argv[2]);
process.stdout.write("held\\n");
setTimeout(() => { release(); process.exit(0); }, ${holdMs});
`,
	);
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, script, file], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	await new Promise<void>((done) => child.stdout.once("data", () => done()));
	return async () => {
		child.kill("SIGKILL");
		await exited;
	};
}

describe("a session append while another process holds the lock", () => {
	it("keeps this process's timers on schedule and writes the record afterwards", async () => {
		const stop = await holdLockFor(500);
		let worstLag = 0;
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			worstLag = Math.max(worstLag, now - last - 5);
			last = now;
		}, 5);
		try {
			last = performance.now();
			session.appendMessage(userMsg("during the hold"));
			await new Promise((done) => setTimeout(done, 1_500));
		} finally {
			clearInterval(timer);
			await stop();
		}
		expect(worstLag).toBeLessThan(20);
		expect(readFileSync(file, "utf8")).toContain("during the hold");
	});
});
