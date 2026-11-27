import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { tmp } from "./helpers.ts";

const source = path.join(import.meta.dirname, "../../src");
const resolver = path.join(import.meta.dirname, "../../scripts/source-resolver.ts");
const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(source, file)).href);

const fixture = `
import fs from "node:fs";
import { spawn } from "node:child_process";
import { runRpcMode } from ${moduleUrl("modes/rpc/rpc-mode.ts")};
import { trackDetachedChildPid } from ${moduleUrl("utils/shell.ts")};
import { endWithParent } from ${moduleUrl("octocode/team/session/parent.ts")};
const [marker, mode] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
 detached: true, stdio: "ignore",
});
trackDetachedChildPid(child.pid);
fs.writeFileSync(marker, String(child.pid));
const session = {
 sessionId: "rpc-shutdown-contract", subscribe: () => () => {},
 agent: { subscribe: () => () => {} },
 bindFeatures: async () => { fs.writeFileSync(marker + ".ready", "yes"); },
};
await runRpcMode({
 session, setRebindSession() {},
 async dispose() {
  fs.writeFileSync(marker + ".disposing", "yes");
  if (mode === "normal") return;
  // The real parent watcher sends this signal while disposal is awaiting work.
  // An immediate at the explicit disposal barrier avoids a timing-based race.
  setImmediate(() => endWithParent(() => {}));
  await new Promise(() => {});
 },
});
`;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	return check();
}

it.each(["normal", "parent-gone", "signal-again"])(
	"reaps a tracked shell during RPC shutdown (%s)",
	async (mode) => {
		const dir = tmp("octocode-agent-rpc-shutdown-");
		const marker = path.join(dir, "shell.pid");
		const script = path.join(dir, "rpc.mjs");
		fs.writeFileSync(script, fixture);
		const rpc = spawn(process.execPath, ["--import", resolver, script, marker, mode], {
			env: { HOME: dir, USERPROFILE: dir, PATH: process.env.PATH, TMPDIR: dir, OCTOCODE_OFFLINE: "1" },
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		rpc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			rpc.once("exit", (code, signal) => resolve({ code, signal })),
		);
		let shell: number | undefined;
		try {
			expect(await until(() => fs.existsSync(marker + ".ready"), 20_000), stderr).toBe(true);
			const shellPid = Number(fs.readFileSync(marker, "utf8"));
			shell = shellPid;
			expect(alive(shellPid)).toBe(true);
			if (mode === "signal-again") rpc.kill("SIGTERM");
			else rpc.stdin.end();
			const exit = await exited;
			const reaped = await until(() => !alive(shellPid), 5_000);
			expect(fs.existsSync(marker + ".disposing")).toBe(true);
			expect({ exit, reaped }, stderr).toEqual({
				exit: { code: mode === "normal" ? 0 : 143, signal: null },
				reaped: true,
			});
		} finally {
			if (rpc.exitCode === null && rpc.signalCode === null) rpc.kill("SIGKILL");
			await exited;
			const remaining = shell;
			if (remaining !== undefined) {
				try {
					process.kill(-remaining, "SIGKILL");
				} catch {
					/* The owned group already ended. */
				}
				await until(() => !alive(remaining), 5_000);
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
	30_000,
);
