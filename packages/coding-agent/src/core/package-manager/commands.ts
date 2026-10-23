import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { spawnProcess, spawnProcessSync } from "../../utils/child-process.ts";
import { isStdoutTakenOver } from "../output-guard.ts";
import type { SpawnCapture } from "./types.ts";

function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

function spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
	const env = getEnv();
	return spawnProcess(command, args, {
		cwd: options?.cwd,
		stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
		env,
	});
}

export function spawnCaptureCommand(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
): ChildProcessByStdio<null, Readable, Readable> {
	const baseEnv = getEnv();
	const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
	return spawnProcess(command, args, {
		cwd: options?.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
}

export function runCommandCapture(
	spawnCapture: SpawnCapture,
	command: string,
	args: string[],
	options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawnCapture(command, args, options);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout =
			typeof options?.timeoutMs === "number"
				? setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeoutMs)
				: undefined;

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		child.once("error", (error) => {
			if (timeout) clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
				return;
			}
			if (code === 0) {
				resolvePromise(stdout.trim());
				return;
			}
			const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
		});
	});
}

export function runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawnCommand(command, args, options);
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolvePromise();
			} else {
				reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
			}
		});
	});
}

export function runCommandSync(command: string, args: string[]): string {
	const env = getEnv();
	const result = spawnProcessSync(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
		env,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
		);
	}
	return (result.stdout || result.stderr || "").trim();
}

export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	if (tasks.length === 0) {
		return [];
	}

	const results: T[] = [];
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, tasks.length));

	const worker = async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= tasks.length) {
				return;
			}
			results[index] = await tasks[index]();
		}
	};

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
