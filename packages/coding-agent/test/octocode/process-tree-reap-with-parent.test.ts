import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reapWithParent } from "../../src/utils/process-tree.ts";
import { processAlive } from "../../src/octocode/shared/process.ts";
import { tmp } from "./helpers.ts";

const posix = process.platform !== "win32";
const treeModule = fileURLToPath(new URL("../../src/utils/process-tree.ts", import.meta.url));

async function until(done: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (done()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return done();
}

/** A stand-in CLI that ignores stdin EOF and the termination signals a polite stop uses. */
function stubborn(dir: string): string {
	const file = path.join(dir, "stubborn.js");
	fs.writeFileSync(
		file,
		'process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});process.stdin.resume();setInterval(()=>{},1000);\n',
	);
	return file;
}

describe.skipIf(!posix)("reapWithParent", () => {
	it("ends a root that ignores EOF and SIGHUP once its parent is killed without cleanup", async () => {
		const dir = tmp("octocode-reap-");
		const report = path.join(dir, "pids.json");
		const parent = path.join(dir, "parent.ts");
		fs.writeFileSync(
			parent,
			`import { spawn } from "node:child_process";
import fs from "node:fs";
import { reapWithParent } from ${JSON.stringify(treeModule)};
const cli = spawn(process.execPath, [${JSON.stringify(stubborn(dir))}], { stdio: ["pipe", "pipe", "pipe"], detached: true });
const watcher = reapWithParent(cli.pid);
// Published whole by a rename: the test waits for the file, and a file it sees is the complete record.
fs.writeFileSync(${JSON.stringify(`${report}.tmp`)}, JSON.stringify({ cli: cli.pid, watcher }));
fs.renameSync(${JSON.stringify(`${report}.tmp`)}, ${JSON.stringify(report)});
setInterval(() => {}, 1000);
`,
		);
		const host = spawn(process.execPath, [parent], { stdio: "ignore" });
		expect(await until(() => fs.existsSync(report), 10_000)).toBe(true);
		const { cli, watcher } = JSON.parse(fs.readFileSync(report, "utf8")) as { cli: number; watcher: number };
		try {
			expect(processAlive(cli)).toBe(true);
			host.kill("SIGKILL");
			expect(await until(() => !processAlive(cli), 8000)).toBe(true);
			expect(await until(() => !processAlive(watcher), 4000)).toBe(true);
		} finally {
			for (const pid of [cli, watcher]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	}, 30_000);

	it("leaves no watcher behind when the root exits while the parent lives", async () => {
		const cli = spawn(process.execPath, ["-e", "setTimeout(()=>{},300)"], { stdio: "ignore", detached: true });
		const watcher = reapWithParent(cli.pid);
		expect(watcher).toBeGreaterThan(0);
		await new Promise((resolve) => cli.once("close", resolve));
		expect(await until(() => !processAlive(watcher), 4000)).toBe(true);
	});

	it("does nothing for an invalid pid", () => {
		expect(reapWithParent(undefined)).toBeUndefined();
		expect(reapWithParent(0)).toBeUndefined();
	});
});
