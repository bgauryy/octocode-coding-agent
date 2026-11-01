import * as fs from "node:fs";
import * as path from "node:path";
import { PASTE_IDLE_TIMEOUT_MS } from "../stdin-buffer.ts";

const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;
/** Over SSH a paste can stall longer between chunks, so its end marker is awaited longer. */
const DEFAULT_SSH_PASTE_TIMEOUT_MS = 3000;

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * Refresh terminal dimensions on POSIX platforms by sending SIGWINCH to this process.
 * Best-effort: some environments (restricted seccomp or LSM policies) return EACCES
 * for `kill(2)`; in that case the dimensions refresh is skipped rather than crashing.
 */
export function refreshTerminalDimensions(): void {
	if (process.platform === "win32" || process.pid <= 0) return;
	try {
		process.kill(process.pid, "SIGWINCH");
	} catch {
		// Signal delivery not permitted in this environment; ignore.
	}
}

export function normalizeNativeShiftEnterInput(
	data: string,
	shouldDetectNativeShiftEnter: boolean,
	isShiftPressed: boolean,
): string {
	if (shouldDetectNativeShiftEnter && data === "\r" && isShiftPressed) return NATIVE_SHIFT_ENTER_SEQUENCE;
	return data;
}

/** A positive number in the environment variable, else the SSH default over SSH, else the local default. */
function resolveTimeoutMs(
	env: NodeJS.ProcessEnv,
	variable: string,
	localDefaultMs: number,
	sshDefaultMs: number,
): number {
	const configured = Number(env[variable]);
	if (Number.isFinite(configured) && configured > 0) return configured;
	return env.SSH_CONNECTION || env.SSH_TTY ? sshDefaultMs : localDefaultMs;
}

/**
 * Resolve how long to wait for the rest of an escape sequence before
 * dispatching a lone ESC as the Escape key. Legacy Alt+key input is ESC plus
 * another byte, so high-latency transports need a longer reassembly window.
 */
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return resolveTimeoutMs(env, "OCTOCODE_TUI_ESC_TIMEOUT", DEFAULT_ESCAPE_TIMEOUT_MS, DEFAULT_SSH_ESCAPE_TIMEOUT_MS);
}

/** How long a bracketed paste may go without input before it is emitted without its end marker. */
export function resolvePasteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return resolveTimeoutMs(env, "OCTOCODE_TUI_PASTE_TIMEOUT", PASTE_IDLE_TIMEOUT_MS, DEFAULT_SSH_PASTE_TIMEOUT_MS);
}

/**
 * Where `OCTOCODE_TUI_WRITE_LOG` sends a copy of everything written: a timestamped file when it names
 * an existing directory, else the path itself. Empty when the variable is unset.
 */
export function resolveWriteLogPath(env: string = process.env.OCTOCODE_TUI_WRITE_LOG || ""): string {
	if (!env) return "";
	try {
		if (fs.statSync(env).isDirectory()) {
			const now = new Date();
			const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
			return path.join(env, `tui-${ts}-${process.pid}.log`);
		}
	} catch {
		// Not an existing directory - use as-is (file path)
	}
	return env;
}
