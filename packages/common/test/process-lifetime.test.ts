import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessLifetime } from "../src/process-lifetime.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifetime-"));
	made.push(dir);
	return dir;
}

describe("process lifetime", () => {
	it("runs the last-resort releases newest first, once, and keeps going past a failing one", () => {
		const lifetime = createProcessLifetime();
		const order: string[] = [];
		const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		lifetime.acquire("a", { atExit: () => order.push("a") });
		lifetime.acquire("b", {
			atExit: () => {
				throw new Error("boom");
			},
		});
		const releaseC = lifetime.acquire("c", { atExit: () => order.push("c") });
		lifetime.acquire("d", { atExit: () => order.push("d") });
		releaseC();
		lifetime.runAtExit();
		lifetime.runAtExit();
		expect(order).toEqual(["d", "a"]);
		expect(error).toHaveBeenCalledWith(expect.stringContaining("could not release b at exit: boom"));
		expect(lifetime.names()).toEqual([]);
	});

	it("awaits graceful releases newest first and reports the ones the deadline cut off", async () => {
		const lifetime = createProcessLifetime();
		const order: string[] = [];
		lifetime.acquire("first", { graceful: async () => void order.push("first") });
		lifetime.acquire("hangs", { graceful: () => new Promise<void>(() => undefined) });
		lifetime.acquire("fails", { graceful: () => Promise.reject(new Error("no")) });
		lifetime.acquire("last", { graceful: async () => void order.push("last") });
		const started = Date.now();
		const result = await lifetime.shutdown(200);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(order).toEqual(["last"]);
		expect(result.failed.map((f) => f.name)).toEqual(["fails"]);
		expect(result.timedOut).toEqual(["hangs", "first"]);
	});

	it("removes a path it was given at exit and refuses roots and the folders that hold them", () => {
		const lifetime = createProcessLifetime();
		const workspace = tempDir();
		const agentDir = path.join(workspace, "agent");
		fs.mkdirSync(agentDir);
		lifetime.protectPath(agentDir);
		for (const target of ["relative/dir", "/", os.homedir(), os.tmpdir(), agentDir, workspace])
			expect(() => lifetime.acquirePath("temp", target)).toThrow(/refusing to remove|not absolute/);
		const inside = fs.mkdtempSync(path.join(agentDir, "made-"));
		const other = tempDir();
		lifetime.acquirePath("inside", inside);
		const keep = lifetime.acquirePath("released", other);
		keep();
		lifetime.runAtExit();
		expect(fs.existsSync(inside)).toBe(false);
		expect(fs.existsSync(other)).toBe(true);
		expect(fs.existsSync(agentDir)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("kills a registered process group at exit, never a positive pid", () => {
		const lifetime = createProcessLifetime();
		const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
		child.unref();
		const pid = child.pid!;
		try {
			lifetime.acquireGroup("sleeper", pid);
			lifetime.runAtExit();
			const deadline = Date.now() + 3_000;
			while (spawnSync("pgrep", ["-g", String(pid)]).status === 0 && Date.now() < deadline)
				spawnSync("sleep", ["0.05"]);
			// No live member is left (the leader, this test's own child, stays a zombie until Node reaps it).
			expect(spawnSync("pgrep", ["-g", String(pid)]).status).not.toBe(0);
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* Already gone. */
			}
		}
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("No such process"), { code: "ESRCH" });
		});
		lifetime.acquireGroup("gone", 456_789);
		lifetime.runAtExit();
		expect(kill).toHaveBeenCalledExactlyOnceWith(-456_789, "SIGKILL");
	});

	it("runs the default instance's releases on process.exit from a single listener", () => {
		const dir = tempDir();
		const target = fs.mkdtempSync(path.join(dir, "gone-"));
		const module = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/process-lifetime.ts");
		const script = `
			const { processLifetime } = await import(${JSON.stringify(module)});
			processLifetime.acquirePath("a", ${JSON.stringify(target)});
			processLifetime.acquire("b", { atExit: () => console.log("b released") });
			console.log("listeners", process.listenerCount("exit"));
			process.exit(3);
		`;
		const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		expect(run.status).toBe(3);
		expect(run.stdout).toContain("listeners 1");
		expect(run.stdout).toContain("b released");
		expect(fs.existsSync(target)).toBe(false);
	});
});
