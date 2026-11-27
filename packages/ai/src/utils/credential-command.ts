/**
 * Structured credential commands (`auth: { command, args, timeoutMs, ttlMs }` in models.json): the program runs without a
 * shell, its trimmed stdout is the key, and a success is cached for `ttlMs`. A failure names its cause (exit status,
 * timeout, a missing program) and the first stderr line with credentials removed, never the output.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";

export interface CredentialCommand {
	command: string;
	args?: readonly string[];
	/** Milliseconds before the run is stopped and fails; default 10 s. */
	timeoutMs?: number;
	/** Milliseconds a printed key is reused; 0 runs the command for every request. Default 5 minutes. */
	ttlMs?: number;
}

const DEFAULT_CREDENTIAL_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_CREDENTIAL_COMMAND_TTL_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_STDERR_CHARS = 4096;
const MAX_DETAIL_CHARS = 200;
/** A word of 20 or more key characters mixing letters and digits: a token in a format no redaction rule knows. */
const TOKEN_LIKE_WORD = /[A-Za-z0-9+/=_.-]{20,}/g;

type CredentialCommandFailure = "exit" | "timeout" | "spawn" | "empty" | "output";

/** Why a credential command gave no key. The message carries no stdout and a redacted stderr line. */
export class CredentialCommandError extends Error {
	readonly failure: CredentialCommandFailure;
	readonly status: number | null | undefined;
	constructor(message: string, failure: CredentialCommandFailure, status?: number | null) {
		super(message);
		this.name = "CredentialCommandError";
		this.failure = failure;
		this.status = status;
	}
}

interface CachedKey {
	value: string;
	expiresAt: number;
}

const cache = new Map<string, CachedKey>();
const pending = new Map<string, Promise<string>>();
/** Moves with every clear: a run that started before it does not cache what it read. */
let generation = 0;

const cacheKey = (spec: CredentialCommand): string => JSON.stringify([spec.command, spec.args ?? []]);

/** `run` for one caller: rejects with the signal's reason when it aborts first; the run itself goes on. */
function raceWithAbortSignal(run: Promise<string>, signal: AbortSignal | undefined): Promise<string> {
	if (!signal) return run;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		run.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** `line` with each token-like word replaced by `[redacted]`; plain words and long paths without digits stay. */
function hideTokenLikeWords(line: string): string {
	return line.replace(TOKEN_LIKE_WORD, (word) => (/[A-Za-z]/.test(word) && /\d/.test(word) ? "[redacted]" : word));
}

/**
 * The first non-empty stderr line, control characters dropped, credentials and token-like words redacted and cut short. Redaction runs on
 * the whole captured text first, so a cut never splits a secret into a shape the redactor no longer knows.
 */
function stderrDetail(stderr: string): string {
	// A capture stopped at the cap may end inside a secret: its unfinished last word is dropped, not shown.
	const whole = stderr.length >= MAX_STDERR_CHARS ? stderr.replace(/\S*$/, "") : stderr;
	const line = redactSecrets(whole)
		.split(/\r?\n/)
		.map((text) => text.trim())
		.find(Boolean);
	if (!line) return "";
	const clean = hideTokenLikeWords(line.replace(/[\u0000-\u001f\u007f]/g, ""));
	return clean.length > MAX_DETAIL_CHARS ? `${clean.slice(0, MAX_DETAIL_CHARS)}…` : clean;
}

function runOnce(spec: CredentialCommand): Promise<string> {
	const name = basename(spec.command);
	const timeoutMs = spec.timeoutMs ?? DEFAULT_CREDENTIAL_COMMAND_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(spec.command, [...(spec.args ?? [])], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const finish = (error: CredentialCommandError | undefined, value?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) {
				if (child.exitCode === null && child.signalCode === null) child.kill();
				reject(error);
			} else resolve(value as string);
		};
		const timer = setTimeout(
			() =>
				finish(
					new CredentialCommandError(`Credential command "${name}" did not finish within ${timeoutMs} ms`, "timeout"),
				),
			timeoutMs,
		);
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > MAX_OUTPUT_CHARS)
				finish(new CredentialCommandError(`Credential command "${name}" printed more than 1 MiB`, "output"));
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish(
				new CredentialCommandError(
					`Credential command "${name}" could not start: ${error.code === "ENOENT" ? "program not found" : (error.code ?? error.message)}`,
					"spawn",
				),
			),
		);
		child.on("close", (status, killSignal) => {
			const detail = stderrDetail(stderr);
			const suffix = detail ? `: ${detail}` : "";
			if (status !== 0) {
				const how = status === null ? `was stopped by ${killSignal ?? "a signal"}` : `exited with status ${status}`;
				finish(new CredentialCommandError(`Credential command "${name}" ${how}${suffix}`, "exit", status));
				return;
			}
			const value = stdout.trim();
			if (!value) {
				finish(new CredentialCommandError(`Credential command "${name}" printed no key${suffix}`, "empty", status));
				return;
			}
			finish(undefined, value);
		});
	});
}

/**
 * The key `spec` prints: from the cache while its `ttlMs` lasts, else from one run that concurrent callers share.
 * Rejects with a `CredentialCommandError`; failures are never cached. `signal` stops this caller's wait, not the shared run,
 * which its timeout bounds.
 */
export function runCredentialCommand(spec: CredentialCommand, signal?: AbortSignal): Promise<string> {
	const key = cacheKey(spec);
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
	cache.delete(key);
	const running = pending.get(key);
	if (running) return raceWithAbortSignal(running, signal);
	const started = generation;
	const ttlMs = spec.ttlMs ?? DEFAULT_CREDENTIAL_COMMAND_TTL_MS;
	const run: Promise<string> = runOnce(spec)
		.then((value) => {
			if (ttlMs > 0 && started === generation) cache.set(key, { value, expiresAt: Date.now() + ttlMs });
			return value;
		})
		.finally(() => {
			if (pending.get(key) === run) pending.delete(key);
		});
	pending.set(key, run);
	return raceWithAbortSignal(run, signal);
}

/** Drops the cached key of `spec` (the provider refused it), so the next request runs the command again. */
export function forgetCredentialCommand(spec: CredentialCommand): void {
	cache.delete(cacheKey(spec));
}

/** Drops every cached key and orphans running commands' results. */
export function clearCredentialCommandCache(): void {
	cache.clear();
	pending.clear();
	generation++;
}
