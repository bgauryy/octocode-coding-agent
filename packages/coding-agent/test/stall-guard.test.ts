import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const GUARD = fileURLToPath(new URL("../src/utils/stall-guard.ts", import.meta.url));

/** Runs `body` in its own Node process with `endIfStalled` imported, and resolves with how that process ended. */
function run(body: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
	const source = `import { endIfStalled, watchMainThread } from ${JSON.stringify(GUARD)};\n${body}`;
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - startedAt }));
	});
}

/** Holds the main thread inside a blocking wait, as a terminal mode switch does on a terminal that stopped reading. */
const BLOCK_30S = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)";

describe.skipIf(process.platform === "win32")("endIfStalled", () => {
	test("ends the process when the call holds the main thread past the limit", async () => {
		const ended = await run(`endIfStalled(() => ${BLOCK_30S}, 300);`);
		expect(ended.signal).toBe("SIGKILL");
		expect(ended.ms).toBeLessThan(15_000);
	}, 30_000);

	test("returns the call's value and leaves a process that finishes in time alone", async () => {
		const ended = await run(
			`const value = endIfStalled(() => 7, 300);\nsetTimeout(() => process.exit(value === 7 ? 0 : 1), 900);`,
		);
		expect(ended).toMatchObject({ code: 0, signal: null });
	}, 30_000);

	test("rethrows the call's error with the guard released", async () => {
		const ended = await run(
			`try { endIfStalled(() => { throw new Error("x"); }, 300); } catch { setTimeout(() => process.exit(3), 900); }`,
		);
		expect(ended).toMatchObject({ code: 3, signal: null });
	}, 30_000);
});

describe.skipIf(process.platform === "win32")("watchMainThread", () => {
	test("ends a process whose main thread stays blocked and leaves a line saying why", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-stall-"));
		const notePath = join(dir, "stalls.jsonl");
		try {
			const ended = await run(
				`watchMainThread({ limitMs: 1500, notePath: ${JSON.stringify(notePath)} });\nsetTimeout(() => ${BLOCK_30S}, 200);`,
			);
			expect(ended.signal).toBe("SIGKILL");
			expect(ended.ms).toBeLessThan(20_000);
			const note = JSON.parse(readFileSync(notePath, "utf8").trim());
			expect(note).toMatchObject({ action: expect.stringContaining("main thread was blocked") });
			expect(note.blockedMs).toBeGreaterThanOrEqual(1500);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 40_000);

	test("leaves a process alone while its main thread keeps running, and stops when told to", async () => {
		const ended = await run(
			`const stop = watchMainThread({ limitMs: 1500 });\nsetTimeout(() => { stop(); process.exit(0); }, 4000);`,
		);
		expect(ended).toMatchObject({ code: 0, signal: null });
	}, 40_000);
});
