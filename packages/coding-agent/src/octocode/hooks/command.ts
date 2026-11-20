import { mkdirSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { leadsProcessGroup } from "../../utils/shell.ts";
import { KILL_GRACE_MS, stopTree } from "../shared/process.ts";
import { HOOK_COMMAND_OUTPUT_MAX_BYTES, type HookCommand, type HookRun } from "./contracts.ts";

/** Drain inherited pipes after natural exit without hiding a hook's decision. */
const EXIT_DRAIN_MS = 150;

/**
 * How long a Claude `async` command hook may run. Claude Code enforces no `timeout` on one, so its own timeout does not
 * apply; this bound only keeps a hung hook from holding its process for the rest of the session.
 */
const CLAUDE_ASYNC_HOOK_TIMEOUT_MS = 10 * 60_000;

export function runCommandHook(
	hook: HookCommand,
	input: Record<string, unknown>,
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<HookRun> {
	if (signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false });
	return new Promise((resolve) => {
		// Detached on POSIX makes the shell a process-group leader, so a timeout can kill everything it started.
		const expand = (value: string) =>
			value.replace(
				/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g,
				(placeholder, key: string) => environment[key] ?? placeholder,
			);
		const executable = hook.args !== undefined;
		const command = process.platform === "win32" && hook.commandWindows ? hook.commandWindows : hook.command;
		let child: ChildProcessWithoutNullStreams;
		try {
			if (hook.plugin) mkdirSync(hook.plugin.data, { recursive: true, mode: 0o700 });
			// Claude `shell: "powershell"` starts PowerShell directly; `args` (exec form) takes no shell at all.
			const powershell = !executable && hook.shell === "powershell";
			const program = powershell ? (process.platform === "win32" ? "powershell" : "pwsh") : command;
			child = spawn(
				executable ? expand(command) : program,
				executable ? hook.args!.map(expand) : powershell ? ["-NoProfile", "-NonInteractive", "-Command", command] : [],
				{
					cwd,
					shell: !executable && !powershell,
					detached: leadsProcessGroup(),
					env: environment,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				},
			);
		} catch (error) {
			resolve({ code: null, stdout: "", stderr: errorMessage(error), timedOut: false });
			return;
		}
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		let exited = false;
		const collect = (chunks: Buffer[], size: number, chunk: Buffer): number => {
			if (size < HOOK_COMMAND_OUTPUT_MAX_BYTES) chunks.push(chunk.subarray(0, HOOK_COMMAND_OUTPUT_MAX_BYTES - size));
			return size + chunk.length;
		};
		child.stdout.on("data", (chunk: Buffer) => {
			outBytes = collect(out, outBytes, chunk);
			return outBytes;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errBytes = collect(err, errBytes, chunk);
			return errBytes;
		});
		let settled = false;
		let stopping: Promise<void> | undefined;
		const stop = () => {
			if (stopping || settled) return;
			stopping = stopTree(child.pid, KILL_GRACE_MS);
			void stopping.then(() => finish(null));
			child.unref();
		};
		const timer = setTimeout(
			() => {
				// A hook that exited has answered; only pipes held open by its children are still running.
				if (exited) return;
				timedOut = true;
				stop();
			},
			hook.protocol === "claude" && hook.async && !hook.asyncRewake ? CLAUDE_ASYNC_HOOK_TIMEOUT_MS : hook.timeoutMs,
		);
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
		const finish = (code: number | null, extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const complete = () => {
				for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
				signal?.removeEventListener("abort", stop);
				const dropped = {
					stdout: Math.max(0, outBytes - HOOK_COMMAND_OUTPUT_MAX_BYTES),
					stderr: Math.max(0, errBytes - HOOK_COMMAND_OUTPUT_MAX_BYTES),
				};
				resolve({
					code,
					stdout: Buffer.concat(out).toString("utf8"),
					stderr: `${Buffer.concat(err).toString("utf8")}${extra}`,
					timedOut,
					...(dropped.stdout + dropped.stderr > 0 ? { dropped } : {}),
				});
			};
			if (stopping) void stopping.then(complete);
			else complete();
		};
		child.on("error", (error) => finish(null, error.message));
		child.on("close", (code) => finish(code));
		// `close` waits for every holder of stdout/stderr: a background child that outlives the hook would hide its exit
		// code (a deny) behind the timeout. The exit code stands once the pipes had a moment to drain.
		child.on("exit", (code) => {
			exited = true;
			setTimeout(() => finish(code), EXIT_DRAIN_MS).unref();
		});
		// A hook that ignores stdin closes the pipe early; that is not an error.
		child.stdin.on("error", () => undefined);
		child.stdin.end(JSON.stringify(input));
	});
}
