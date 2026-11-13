import { accessSync, constants } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { findEnvKeys } from "@octocodeai/octocode-ai/compat";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import { getAgentDir, getBinDir, getLegacyProviderDirs } from "../config.ts";
import { modelsEnvKeyNames } from "../core/models-json-keys.ts";
import { adoptTree, prepareTree, signalTree } from "./process-tree.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = win32.normalize(path).toLowerCase();
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false;
		return ["System32", "Sysnative"].some(
			(directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
		);
	}
	// Fall back to conventional launcher paths only when the Windows directory is unknown.
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

// On Unix this is identical to existsSync() (both are access(F_OK)), just
// spelled with try/catch. On Windows we explicitly avoid existsSync(): its
// extra stat check rejects runnable Store aliases (nodejs/node#36790).
function shellPathExists(path: string): boolean {
	try {
		accessSync(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows: use 'where' and check the returned path.
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && shellPathExists(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (shellPathExists(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (shellPathExists(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (shellPathExists("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	let shell = findExecutableOnPath("pwsh.exe");
	// Installation directories may be on any drive and need not be on PATH.
	const programFiles = process.env.ProgramFiles;
	if (!shell && programFiles) {
		const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
		if (shellPathExists(pwsh7)) shell = pwsh7;
	}

	shell ??= findExecutableOnPath("powershell.exe");
	const systemRoot = process.env.SystemRoot;
	if (!shell && systemRoot) {
		const windowsPowerShell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (shellPathExists(windowsPowerShell)) shell = windowsPowerShell;
	}

	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

/** Which shell runs a command: PowerShell on Windows when asked, else the configured or discovered bash. */
export function resolveShell(settings: { type?: string; shellPath?: string } = {}): ShellConfig {
	return settings.type === "powershell" ? getPowerShellConfig() : getShellConfig(settings.shellPath);
}

/** Node timers fire at once beyond 2^31-1 ms; every shell timeout is clamped to what they can hold. */
export const MAX_TIMER_MS = 2_147_483_647;
const MAX_TIMER_SECONDS = Math.floor(MAX_TIMER_MS / 1000);

/** A shell timeout in seconds, at most `MAX_TIMER_SECONDS`; a missing, non-finite or non-positive one means no timeout. */
export function clampTimeoutSeconds(seconds: number | undefined): number | undefined {
	return seconds !== undefined && Number.isFinite(seconds) && seconds > 0
		? Math.min(seconds, MAX_TIMER_SECONDS)
		: undefined;
}

/**
 * Whether a child should lead its own process group: POSIX trees are the group (signalled with `signalTree`);
 * Windows has none and tracks the tree through a job instead (`prepareTree`/`adoptTree`).
 */
export function leadsProcessGroup(): boolean {
	return process.platform !== "win32";
}

/**
 * Starts `command` in `shell` with piped stdout and stderr, as the root of a process tree that `signalTree` can end:
 * detached into its own group on POSIX, in a Windows job (ready before the shell starts) on Windows. The command goes
 * over stdin when the shell takes it that way, else as the last argument. A spawn that fails reports through the
 * child's `error` event and leaves `pid` undefined.
 */
export async function spawnShell(
	shell: ShellConfig,
	command: string,
	{ cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ChildProcess> {
	const viaStdin = shell.commandTransport === "stdin";
	await prepareTree();
	const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], {
		cwd,
		detached: leadsProcessGroup(),
		env,
		stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (viaStdin) {
		// The shell may exit before reading its stdin; its exit code is reported, a broken pipe is not news.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(command);
	}
	adoptTree(child.pid);
	return child;
}

let keepProviderKeys = false;
let extraPathEntries: () => readonly string[] = () => [];

/**
 * Folders every shell command finds before Octocode's `bin`: `octocode/index.ts` installs the research CLI's shim folder
 * (`octocode/cli/shim.ts`) here, so `octocode` in an agent shell is that CLI whatever the user's path holds.
 */
export function setShellPathEntries(entries: () => readonly string[]): void {
	extraPathEntries = entries;
}

/** The `bash.inheritProviderKeys` setting: `octocode/files/bash-env.ts` applies it when a session starts. */
export function setShellKeepsProviderKeys(keep: boolean): void {
	keepProviderKeys = keep;
}

/**
 * The environment every shell command starts from: this process's, with the `setShellPathEntries` folders and then
 * Octocode's `bin` first on the path, and without the
 * provider API keys it found, including those custom providers in `models.json` name (`bash.inheritProviderKeys` keeps them). A command's output reaches the model and a build
 * script reads its environment, while the session itself already holds what it needs. Same-user `auth.json` reads remain
 * possible, so this is defence in depth, as `web-daemon/spawn-env.ts` is for the daemon and the MCP transport's filter for
 * servers. A tool's own token (`GH_TOKEN`) is the user's tool working, and stays.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const missing = [...new Set([...extraPathEntries(), getBinDir()])].filter((dir) => !pathEntries.includes(dir));
	const updatedPath = [...missing, currentPath].filter(Boolean).join(delimiter);

	const env: NodeJS.ProcessEnv = { ...process.env, [pathKey]: updatedPath };
	if (!keepProviderKeys) for (const name of providerKeyNames(env)) delete env[name];
	return env;
}

/**
 * The provider API-key variables set in `env`: every built-in provider's, and those custom providers in `models.json`
 * name. The one list behind the shell's removal above and the environment an external ACP agent starts with.
 */
export function providerKeyNames(env: NodeJS.ProcessEnv): string[] {
	const names = new Set<string>();
	for (const provider of builtinProviders())
		for (const name of findEnvKeys(provider.id, env as Record<string, string>) ?? []) names.add(name);
	// A custom provider's key comes from the variable its `apiKey` or a header names (`$NAME`), in every models.json
	// the session merges: Octocode's own, then the read-only legacy and Pi folders.
	for (const dir of [getAgentDir(), ...getLegacyProviderDirs()])
		for (const name of modelsEnvKeyNames(join(dir, "models.json"))) names.add(name);
	return [...names];
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Unicode interlinear annotation characters U+FFF9..U+FFFB (crash string-width due to a bug)
 */
export function sanitizeBinaryOutput(str: string): string {
	// All removed characters are single UTF-16 code units, so surrogate pairs are never split.
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/**
 * Detached child processes (bash trees, subagents) must be tracked so they can be killed on parent shutdown signals
 * (SIGHUP/SIGTERM), an emergency or uncaught-exception exit, and any `process.exit` that comes before they stopped:
 * their process groups survive the death of this process. A normal stop untracks them first. A `graceful` child (a
 * subagent) is stopped by the graceful shutdown itself, so it can report and save its work: a signal handler spares it
 * (`sparingGraceful`), and only an exit, crash or emergency exit kills it. Ctrl+Z does not stop them: each runs in a
 * session of its own without a controlling terminal, outside the foreground group the suspend stops (`lifecycle.ts`).
 */
const trackedDetachedChildPids = new Set<number>();
const gracefulDetachedChildPids = new Set<number>();
let exitHookInstalled = false;

export function trackDetachedChildPid(pid: number, options?: { graceful?: boolean }): void {
	trackedDetachedChildPids.add(pid);
	if (options?.graceful) gracefulDetachedChildPids.add(pid);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		// Synchronous, so it runs on every `process.exit`, where a pending SIGKILL timer would be lost.
		process.on("exit", () => killTrackedDetachedChildren());
	}
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	gracefulDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(options?: { sparingGraceful?: boolean }): void {
	for (const pid of trackedDetachedChildPids) {
		if (options?.sparingGraceful && gracefulDetachedChildPids.has(pid)) continue;
		if (process.platform === "win32") signalTree(pid, "SIGKILL");
		else {
			try {
				// Every tracked POSIX child leads a group. Its root PID may be reused after it exits.
				process.kill(-pid, "SIGKILL");
			} catch {
				// The group is gone; never fall back to a possibly unrelated positive PID.
			}
		}
		untrackDetachedChildPid(pid);
	}
}
