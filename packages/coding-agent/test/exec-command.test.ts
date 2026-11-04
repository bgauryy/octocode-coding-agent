import { describe, expect, it } from "vitest";
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
});
