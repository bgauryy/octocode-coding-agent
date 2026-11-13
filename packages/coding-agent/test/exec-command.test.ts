import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

const node = (script: string) => ["-e", script];

describe.skipIf(process.platform === "win32")("execCommand", () => {
	it("reports a child that a signal ended as a failure, not code 0", async () => {
		const result = await execCommand(process.execPath, node("process.kill(process.pid, 'SIGKILL')"), process.cwd());
		expect(result.code).toBe(128 + 9);
		expect(result.killed).toBe(false);
	});

	it("keeps a normal exit code and its output", async () => {
		const result = await execCommand(
			process.execPath,
			node("console.log('out'); console.error('err'); process.exit(3)"),
			process.cwd(),
		);
		expect(result).toEqual({ stdout: "out\n", stderr: "err\n", code: 3, killed: false });
	});

	it("keeps why a command could not start", async () => {
		const result = await execCommand("definitely-not-a-command-xyz", [], process.cwd());
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ENOENT");
	});

	it("forces a child that ignores SIGTERM to stop", async () => {
		const started = Date.now();
		const result = await execCommand(
			process.execPath,
			node("process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 30000)"),
			process.cwd(),
			{ timeout: 300 },
		);
		expect(result.killed).toBe(true);
		expect(result.code).toBe(128 + 9);
		// 300 ms, then the 5 s grace: far short of the child's own 30 s.
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 20_000);

	it("stops a child when the signal aborts", async () => {
		const controller = new AbortController();
		const running = execCommand(process.execPath, node("setTimeout(() => {}, 30000)"), process.cwd(), {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);
		const result = await running;
		expect(result.killed).toBe(true);
		expect(result.code).toBe(128 + 15);
	}, 20_000);

	it("runs the command as the leader of its own group, outside the terminal's foreground group", async () => {
		const result = await execCommand("sh", ["-c", 'echo "$$ $(ps -o pgid= -p $$)"'], process.cwd());
		const [pid, pgid] = result.stdout.trim().split(/\s+/);
		expect(result.code).toBe(0);
		expect(pgid).toBe(pid);
		expect(Number(pgid)).not.toBe(Number(execSync("ps -o pgid= -p $PPID", { encoding: "utf8" }).trim()));
	});

	it("stops the command's whole tree when the signal aborts", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-tree-"));
		const file = path.join(dir, "grandchild");
		const controller = new AbortController();
		try {
			const running = execCommand("sh", ["-c", `sleep 30 & echo $! > "${file}"; wait`], process.cwd(), {
				signal: controller.signal,
			});
			await vi.waitFor(() => expect(fs.readFileSync(file, "utf8")).toMatch(/^\d+\n$/));
			const grandchild = Number(fs.readFileSync(file, "utf8"));
			controller.abort();
			const result = await running;
			expect(result.killed).toBe(true);
			await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow());
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);
});
