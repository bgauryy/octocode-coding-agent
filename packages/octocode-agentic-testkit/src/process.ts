import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxLaunch, type SandboxOptions } from "./sandbox.ts";

/** What a finished harness process left behind. */
export interface ProcessRun {
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
	/** Parsed JSON lines of stdout; non-JSON lines are skipped. */
	events: Record<string, unknown>[];
	home: string;
	workspace: string;
}

export interface ProcessOptions {
	env: Record<string, string>;
	cwd: string;
	timeoutMs: number;
	home: string;
	/**
	 * `false` (default) runs on the host. Options run the process in the OS sandbox (macOS Seatbelt): writes only to the
	 * run's root and workspace, loopback network only. Rejects, never runs unsandboxed, when the sandbox cannot start.
	 */
	sandbox?: false | SandboxOptions;
}

/**
 * Runs a prepared command in its own process group (in the sandbox when `o.sandbox` is set); resolves with the
 * captured output and parsed JSON lines.
 */
export async function runProcess(command: string, args: string[], o: ProcessOptions): Promise<ProcessRun> {
	if (!o.sandbox) return spawnRun(command, args, o);
	const launch = await sandboxLaunch(command, args, { cwd: o.cwd, home: o.home, env: o.env }, o.sandbox);
	try {
		return await spawnRun(launch.file, launch.args, o);
	} finally {
		launch.release();
	}
}

function spawnRun(command: string, args: string[], o: ProcessOptions): Promise<ProcessRun> {
	const started = Date.now();
	return new Promise((done, fail) => {
		const child = spawn(command, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: o.env });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		const killGroup = (): void => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				// already gone
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, o.timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			fail(e);
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			killGroup();
			const events: Record<string, unknown>[] = [];
			for (const line of stdout.split("\n")) {
				try {
					const v = JSON.parse(line) as unknown;
					if (v && typeof v === "object") events.push(v as Record<string, unknown>);
				} catch {
					// not a JSON line
				}
			}
			done({
				exitCode,
				signal,
				timedOut,
				durationMs: Date.now() - started,
				stdout,
				stderr,
				events,
				home: o.home,
				workspace: o.cwd,
			});
		});
	});
}

/** Writes `relative path -> content` under `dir`, creating parent directories. */
export function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const p = join(dir, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
}
