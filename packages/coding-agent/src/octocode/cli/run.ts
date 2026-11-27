import { spawn } from "node:child_process";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { CommandContext } from "../../core/features/index.ts";
import { holdTerminalForChild } from "../../utils/foreground-child.ts";
import { getShellEnv } from "../../utils/shell.ts";
import { spawnProcess, waitForChildProcess } from "@octocodeai/octocode-common/child-process";
import { processLifetime } from "@octocodeai/octocode-common/process-lifetime";
import { cliRuntime } from "./resolve.ts";

/** What a captured run printed: stdout and stderr interleaved in `output`, stdout alone in `stdout`, each bounded. */
export interface CapturedRun {
	output: string;
	stdout: string;
	code: number | null;
	/** More than `maxBytes` came on a stream; the rest was dropped. */
	truncated: boolean;
	/** `signal` aborted before the CLI exited, so it was stopped. */
	cancelled: boolean;
}

/** A buffer that keeps the first `max` bytes written to it. */
function bounded(max: number) {
	const chunks: Buffer[] = [];
	let kept = 0;
	const state = { truncated: false };
	return {
		state,
		keep(chunk: Buffer): void {
			const room = max - kept;
			if (chunk.length > room) state.truncated = true;
			if (room <= 0) return;
			const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
			chunks.push(part);
			kept += part.length;
		},
		text: (): string => Buffer.concat(chunks).toString("utf8").trimEnd(),
	};
}

/**
 * Runs the CLI at `bin` with `argv` as given, stdin closed and output piped, in the environment agent shells get (so the
 * same `octocode` and credentials). `signal` stops it, and so does Octocode exiting; a spawn failure rejects.
 */
export async function captureCli(
	bin: string,
	argv: string[],
	options: { cwd: string; signal: AbortSignal; maxBytes: number },
): Promise<CapturedRun> {
	const child = spawnProcess(cliRuntime(), [bin, ...argv], {
		cwd: options.cwd,
		env: getShellEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const all = bounded(options.maxBytes);
	const out = bounded(options.maxBytes);
	child.stdout.on("data", (chunk: Buffer) => {
		all.keep(chunk);
		out.keep(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => all.keep(chunk));
	const stop = () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	};
	if (options.signal.aborted) stop();
	else options.signal.addEventListener("abort", stop, { once: true });
	// A session that ends (quit, a shutdown signal) must not leave the CLI running.
	const atExit = processLifetime.acquire("octocode CLI run", { atExit: stop });
	try {
		const code = await waitForChildProcess(child, options.signal);
		return {
			output: all.text(),
			stdout: out.text(),
			code,
			truncated: all.state.truncated,
			cancelled: options.signal.aborted,
		};
	} finally {
		options.signal.removeEventListener("abort", stop);
		atExit();
	}
}

/** Whether this process owns a terminal it can hand to a child: stdin and stdout are both TTYs. */
export function ownsTerminal(): boolean {
	return process.stdin.isTTY && process.stdout.isTTY;
}

/** Waits for one key on the raw terminal, so the CLI's last screen stays readable; `signal` ends the wait. */
function waitForKey(signal: AbortSignal | undefined): Promise<void> {
	const stdin = process.stdin;
	if (!stdin.isTTY || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const wasRaw = stdin.isRaw;
		const done = () => {
			stdin.removeListener("data", done);
			signal?.removeEventListener("abort", done);
			stdin.setRawMode(wasRaw);
			stdin.pause();
			resolve();
		};
		stdin.setRawMode(true);
		stdin.on("data", done);
		signal?.addEventListener("abort", done, { once: true });
		stdin.resume();
	});
}

/**
 * Runs the CLI on the real terminal, as the external editor does: the TUI stops, the CLI inherits stdio (so prompts,
 * colors and the device flow work as in a shell), and after it exits a key press starts the TUI again. Its Ctrl+C is
 * its own, not an Octocode shutdown; `ctx.signal` or Octocode exiting stops it. Undefined when this mode has no
 * terminal UI (`custom` never builds the component), so nothing ran. The outcome is the CLI's exit, not what `custom`
 * resolves: another dialog taking the slot ends `custom` early while the CLI still owns the terminal.
 */
export async function runCliInTerminal(
	ctx: CommandContext,
	bin: string,
	argv: string[],
	label: string,
): Promise<number | null | undefined> {
	let exited: Promise<number | null> | undefined;
	await ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
		let resolveExit: (code: number | null) => void = () => undefined;
		exited = new Promise((resolve) => {
			resolveExit = resolve;
		});
		tui.stop();
		const release = holdTerminalForChild();
		let child: ReturnType<typeof spawn> | undefined;
		let stopped = false;
		const stop = () => {
			stopped = true;
			if (child && child.exitCode === null && child.signalCode === null) child.kill();
		};
		ctx.signal?.addEventListener("abort", stop, { once: true });
		const atExit = processLifetime.acquire("octocode CLI in the terminal", { atExit: stop });
		let finished = false;
		const finish = async (exit: number | null) => {
			if (finished) return;
			finished = true;
			ctx.signal?.removeEventListener("abort", stop);
			atExit();
			process.stdout.write(`\n${label} exited with ${exit ?? "an error"}. Press any key to return to Octocode.`);
			try {
				await waitForKey(ctx.signal);
			} finally {
				process.stdout.write("\n");
				release();
				tui.start();
				tui.requestRender(true);
				resolveExit(exit);
				done(exit);
			}
		};
		const start = async () => {
			// The restore sequences `stop` queued reach the terminal before this text and the CLI draw on it.
			await tui.terminal?.drainOutput?.();
			if (stopped) return finish(null);
			process.stdout.write(`Running ${label}\nOctocode resumes when it exits.\n`);
			child = spawn(cliRuntime(), [bin, ...argv], { cwd: ctx.cwd, env: getShellEnv(), stdio: "inherit" });
			child.on("error", (error) => {
				process.stderr.write(`${error.message}\n`);
				void finish(null);
			});
			child.on("close", (exit) => void finish(exit));
		};
		start().catch((error: unknown) => {
			process.stderr.write(`${errorMessage(error)}\n`);
			void finish(null);
		});
		return { render: () => [], invalidate: () => undefined };
	});
	return exited;
}
