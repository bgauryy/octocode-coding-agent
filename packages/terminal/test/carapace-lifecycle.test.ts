import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { carapaceComplete } from "../src/carapace.ts";

function killOwnedProcess(pid: number | undefined): void {
	if (!pid || !Number.isInteger(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

it.skipIf(process.platform === "win32")("cancellation terminates carapace even if it ignores SIGTERM", async () => {
	const dir = mkdtempSync(join(tmpdir(), "octocode-carapace-lifecycle-"));
	const binary = join(dir, "completion");
	const pidFile = join(dir, "pid");
	writeFileSync(
		binary,
		`#!${process.execPath}
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
		{ mode: 0o700 },
	);
	const abort = new AbortController();
	let pid: number | undefined;
	const completion = carapaceComplete(binary, ["git", ""], { cwd: dir, env: process.env, signal: abort.signal });
	try {
		await vi.waitFor(() => {
			pid = Number(readFileSync(pidFile, "utf8"));
		});
		abort.abort();
		expect(await completion).toBeUndefined();
		await vi.waitFor(() => {
			expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		});
	} finally {
		abort.abort();
		await completion;
		killOwnedProcess(pid);
		rmSync(dir, { recursive: true, force: true });
	}
});
