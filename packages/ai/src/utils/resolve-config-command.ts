/**
 * The `!command` half of config values: runs the command through the shell, caches successful results briefly, and
 * resolves without blocking the thread when the caller can wait (`executeCommandAsync`).
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { clearCredentialCommandCache } from "./credential-command.ts";

/** How to start a shell on this host; `getShellConfig` of the coding agent is the usual provider. */
export interface ConfigValueShell {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

let configuredShell: (() => ConfigValueShell) | undefined;

/** Sets how `!command` values find the shell on Windows. Without one they run through the default shell. */
export function setConfigValueShell(provider: (() => ConfigValueShell) | undefined): void {
	configuredShell = provider;
}

// Successful shell command results are cached briefly so rotating tokens (gcloud, keychains) refresh; failures never are.
const COMMAND_RESULT_TTL_MS = 5 * 60_000;
// In its last minute a cached result is still served while the command runs again in the background, so a request
// does not wait for it; a failed refresh keeps the cached result until it expires.
const COMMAND_REFRESH_AHEAD_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10_000;
/** `execSync`'s default `maxBuffer`: more output fails the command on either path. */
const COMMAND_MAX_OUTPUT = 1024 * 1024;
interface CachedCommandResult {
	value: string;
	expiresAt: number;
	refreshing?: boolean;
}
const commandResultCache = new Map<string, CachedCommandResult>();
/** Commands running for `executeCommandAsync`: concurrent reads of one reference share one run. */
const pendingCommands = new Map<string, Promise<string | undefined>>();
/** Moves with every `clearConfigValueCache`: a run that started before a clear does not cache what it read. */
let cacheGeneration = 0;

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		if (!configuredShell) return { executed: false, value: undefined };
		const { shell, args, commandTransport } = configuredShell();
		const commandFromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

/** What a command run produced: its trimmed output, or why it produced none (never the command text or its output). */
export interface CommandRun {
	value: string | undefined;
	failure?: string;
}

function describeCommandError(error: unknown): string {
	const { code, status, signal } = error as { code?: string; status?: number | null; signal?: string | null };
	if (code === "ETIMEDOUT") return `timed out after ${COMMAND_TIMEOUT_MS / 1000} s`;
	if (typeof status === "number") return `exited with status ${status}`;
	if (signal) return `was stopped by ${signal}`;
	return "could not be run";
}

function executeWithDefaultShell(command: string): CommandRun {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output ? { value: output } : { value: undefined, failure: "printed nothing" };
	} catch (error) {
		return { value: undefined, failure: describeCommandError(error) };
	}
}

/** Runs the command like `executeCommandUncached`, and says why when it yields no value. */
export function runCommandUncached(commandConfig: string): CommandRun {
	const command = commandConfig.slice(1);
	if (process.platform !== "win32") return executeWithDefaultShell(command);
	const configured = executeWithConfiguredShell(command);
	return configured.executed ? { value: configured.value } : executeWithDefaultShell(command);
}

export function executeCommandUncached(commandConfig: string): string | undefined {
	return runCommandUncached(commandConfig).value;
}

/**
 * Run a command without blocking: stdout trimmed when it exits 0, else undefined. `executed` is false when the shell
 * itself could not start. The child keeps the process alive only with `keepAlive` (a caller awaits its result).
 */
function runCommandInBackground(
	file: string,
	args: string[],
	options: { input?: string; shell: boolean; keepAlive: boolean },
): Promise<{ executed: boolean; value: string | undefined }> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const finish = (result: { executed: boolean; value: string | undefined }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const child = spawn(file, args, {
			shell: options.shell,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
			windowsHide: true,
		});
		const timer = setTimeout(() => {
			child.kill();
			finish({ executed: true, value: undefined });
		}, COMMAND_TIMEOUT_MS);
		timer.unref();
		if (!options.keepAlive) {
			child.unref();
			(child.stdout as { unref?: () => void } | null)?.unref?.();
		}
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length <= COMMAND_MAX_OUTPUT) return;
			child.kill();
			finish({ executed: true, value: undefined });
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish({ executed: error.code !== "ENOENT", value: undefined }),
		);
		child.on("close", (status) =>
			finish({ executed: true, value: status === 0 ? stdout.trim() || undefined : undefined }),
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

/** `executeCommandUncached` without blocking the thread; see `runCommandInBackground` for `keepAlive`. */
async function executeCommandInBackground(commandConfig: string, keepAlive: boolean): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	if (process.platform === "win32" && configuredShell) {
		try {
			const { shell, args, commandTransport } = configuredShell();
			const fromStdin = commandTransport === "stdin";
			const result = await runCommandInBackground(shell, fromStdin ? args : [...args, command], {
				shell: false,
				keepAlive,
				...(fromStdin ? { input: command } : {}),
			});
			if (result.executed) return result.value;
		} catch {
			// Falls back to the default shell, as the synchronous path does.
		}
	}
	return (await runCommandInBackground(command, [], { shell: true, keepAlive })).value;
}

function refreshCommandResult(commandConfig: string, entry: CachedCommandResult): void {
	if (entry.refreshing) return;
	entry.refreshing = true;
	void executeCommandInBackground(commandConfig, false).then(
		(value) => {
			// Cleared or replaced meanwhile; a failure leaves the cached result to expire.
			if (value === undefined || commandResultCache.get(commandConfig) !== entry) return;
			commandResultCache.set(commandConfig, { value, expiresAt: Date.now() + COMMAND_RESULT_TTL_MS });
		},
		() => undefined,
	);
}

export function executeCommand(commandConfig: string): string | undefined {
	const cached = commandResultCache.get(commandConfig);
	const now = Date.now();
	if (cached && cached.expiresAt > now) {
		if (cached.expiresAt - now <= COMMAND_REFRESH_AHEAD_MS) refreshCommandResult(commandConfig, cached);
		return cached.value;
	}
	commandResultCache.delete(commandConfig);

	const result = executeCommandUncached(commandConfig);
	if (result !== undefined) {
		commandResultCache.set(commandConfig, { value: result, expiresAt: Date.now() + COMMAND_RESULT_TTL_MS });
	}
	return result;
}

/**
 * `executeCommand` without blocking the thread: the same command, cache and result, the command run in the background.
 * Concurrent calls for one reference share one run.
 */
export function executeCommandAsync(commandConfig: string): Promise<string | undefined> {
	const cached = commandResultCache.get(commandConfig);
	const now = Date.now();
	if (cached && cached.expiresAt > now) {
		if (cached.expiresAt - now <= COMMAND_REFRESH_AHEAD_MS) refreshCommandResult(commandConfig, cached);
		return Promise.resolve(cached.value);
	}
	const pending = pendingCommands.get(commandConfig);
	if (pending) return pending;
	commandResultCache.delete(commandConfig);
	const generation = cacheGeneration;
	const run = executeCommandInBackground(commandConfig, true)
		.catch(() => undefined)
		.then((value) => {
			if (pendingCommands.get(commandConfig) === run) pendingCommands.delete(commandConfig);
			if (value !== undefined && generation === cacheGeneration)
				commandResultCache.set(commandConfig, { value, expiresAt: Date.now() + COMMAND_RESULT_TTL_MS });
			return value;
		});
	pendingCommands.set(commandConfig, run);
	return run;
}

/** Clear the config value command cache, structured credential commands' too (a keychain write, a test). */
export function clearConfigValueCache(): void {
	clearCredentialCommandCache();
	commandResultCache.clear();
	pendingCommands.clear();
	cacheGeneration++;
}
