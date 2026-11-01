import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobLines } from "../../src/octocode/files/bash/results.ts";
import type { BashJob } from "../../src/octocode/files/bash-jobs/types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const job = (log: string) => ({ log, pid: 42 }) as unknown as BashJob;
const check = (lines: string[]) => (lines[1] ?? "").replace(/^Check: /, "");

describe("background job lines", () => {
	it.skipIf(process.platform === "win32")(
		"the Check command runs as shown when the log path holds spaces and quotes",
		() => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job lines "));
			dirs.push(dir);
			const log = path.join(dir, "it's a log.log");
			fs.writeFileSync(log, "one\ntwo\n");
			const command = check(jobLines(job(log), path.join(os.tmpdir(), "elsewhere")));
			expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("one\ntwo\n");
		},
	);

	it("keeps a plain path and the home tilde unquoted", () => {
		const home = os.homedir();
		expect(check(jobLines(job(path.join(home, ".octocode", "bash", "bash-1.log")), "/nowhere"))).toBe(
			`tail -n 40 ~${path.sep}${path.join(".octocode", "bash", "bash-1.log")}`,
		);
		expect(check(jobLines(job(path.join(home, "My Logs", "b.log")), "/nowhere"))).toBe(
			`tail -n 40 ~${path.sep}'${path.join("My Logs", "b.log")}'`,
		);
	});
});
