import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { probeAcpSignIn } from "../../../../acp/src/client/probe.ts";
import { atomicWriteFileSync, sha256 } from "../../../../common/src/atomic-file.ts";
import { spawnProcess, waitForChildProcess } from "../../../../common/src/child-process.ts";
import { withFileWriteLock } from "../../../../common/src/file-write-lock.ts";
import { PRIVATE_FILE_MODE } from "../../../../common/src/file-mode.ts";
import { findOnPath } from "../../../../common/src/find-on-path.ts";
import { getAgentDir } from "../../config.ts";
import { headlessReady } from "./runner-headless.ts";
import { acpClientHost } from "./acp-host.ts";
import { agentEnv } from "./runner-env.ts";
import { olderThan, RUNNERS, type RunnerAuth, runnerHome, type RunnerSpec, versionOf } from "./runners.ts";

/** A runner as this machine has it: installed (CLI and adapter), its version, and whether it is signed in. */
export interface RunnerState {
	id: string;
	name: string;
	/** The vendor CLI is on PATH. */
	cli: boolean;
	/** The ACP adapter is on PATH. */
	adapter: boolean;
	version?: string;
	/** The version is older than the one whose commands were checked (`RunnerSpec.tested`). */
	untested?: boolean;
	/** Undefined while unknown; `error` then says why. */
	auth?: RunnerAuth;
	error?: string;
	checkedAt?: number;
}

/** How long a status command or session check may take before the runner counts as unknown. */
const CHECK_MS = 10_000;
/** The most of a status command's output that is read; a status line is short. */
const MAX_OUTPUT = 64 * 1024;

const cacheFile = (agentDir: string) => path.join(agentDir, "external-runners.json");

const mtime = (file: string): number => {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
};

/**
 * What the check depends on: where the CLI and adapter are, when they were installed, and when the files that hold the
 * sign-in last changed. Folders and the CLIs' general state files are left out: the CLIs rewrite them in ordinary use,
 * which would drop a signed-in runner from every new session. A sign-out the stamp cannot see (a Keychain token) shows
 * at the next run, which is refused as signed out and forgets the runner (`forgetRunner`).
 */
function stamp(spec: RunnerSpec, env: NodeJS.ProcessEnv): { cli?: string; adapter?: string; key: string } {
	const cli = findOnPath(spec.cli, env);
	const adapter = findOnPath(spec.adapter.command, env);
	const files = spec.signInFiles(env, runnerHome(env));
	return {
		cli,
		adapter,
		key: JSON.stringify([
			cli,
			cli && mtime(cli),
			adapter,
			adapter && mtime(adapter),
			...files.map((file) => [file, mtime(file)]),
			// A runner may use an exported token instead of a file; never store the token itself.
			sha256(JSON.stringify(spec.keep.map((name) => [name, env[name]]))),
		]),
	};
}

type Cache = Record<string, { stamp: string; state?: RunnerState; revision?: string }>;

function readCache(agentDir: string): Cache {
	try {
		const parsed: unknown = JSON.parse(readFileSync(cacheFile(agentDir), "utf8"));
		return isRecord(parsed) ? (parsed as Cache) : {};
	} catch {
		return {};
	}
}

/** Merge under the shared file lock; no vendor command runs while it is held. */
async function updateCache(agentDir: string, update: (cache: Cache) => void, signal?: AbortSignal): Promise<void> {
	try {
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		await withFileWriteLock(
			cacheFile(agentDir),
			async (_target, assertHeld) => {
				const cache = readCache(agentDir);
				signal?.throwIfAborted();
				update(cache);
				assertHeld();
				atomicWriteFileSync(cacheFile(agentDir), `${JSON.stringify(cache, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
			},
			signal,
		);
	} catch {
		// A cache write failure makes the next explicit check run again.
	}
}

/** Runs a status command with the cleaned environment; resolves with its output (read, never kept) and exit code. */
async function quiet(command: string, args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
	const deadline = AbortSignal.timeout(CHECK_MS);
	const giveUp = signal ? AbortSignal.any([signal, deadline]) : deadline;
	giveUp.throwIfAborted();
	const child = spawnProcess(command, [...args], {
		env,
		cwd: os.tmpdir(),
		stdio: ["ignore", "pipe", "pipe"],
		signal: giveUp,
		killSignal: "SIGKILL",
		windowsHide: true,
	});
	let output = "";
	const take = (chunk: Buffer) => {
		if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
	};
	child.stdout.on("data", take);
	child.stderr.on("data", take);
	const code = await waitForChildProcess(child, giveUp);
	giveUp.throwIfAborted();
	return { output, code };
}

/** The session check for a runner without a status command: in an empty folder of its own, removed afterwards. */
async function sessionCheck(
	spec: RunnerSpec,
	adapter: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<Pick<RunnerState, "auth" | "error">> {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "octocode-runner-check-"));
	try {
		const found = await probeAcpSignIn(
			{ ...acpClientHost, childEnv: () => env },
			{ command: adapter, args: [...spec.adapter.args], vendor: spec.id, cwd, timeoutMs: CHECK_MS },
			signal,
		);
		if ("error" in found) return { error: found.error };
		return { auth: found.signedIn ? { signedIn: true } : { signedIn: false } };
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

/** One runner's check: its version, then its own status command, then the session check when that says nothing. */
async function check(spec: RunnerSpec, found: ReturnType<typeof stamp>, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
	const state: RunnerState = { id: spec.id, name: spec.name, cli: Boolean(found.cli), adapter: Boolean(found.adapter) };
	if (!found.cli) return state;
	const clean = agentEnv(spec.id, env);
	try {
		state.version = versionOf((await quiet(found.cli, ["--version"], clean, signal)).output);
		if (state.version && olderThan(state.version, spec.tested)) state.untested = true;
		if (spec.status) {
			const status = await quiet(found.cli, spec.status.args, clean, signal);
			state.auth = spec.status.read(status.output, status.code);
		}
		if (!state.auth && found.adapter) Object.assign(state, await sessionCheck(spec, found.adapter, clean, signal));
		if (!state.auth && !state.error) state.error = "its status could not be read";
	} catch (error) {
		state.error = errorMessage(error);
	}
	state.checkedAt = Date.now();
	return state;
}

/**
 * The known runners (or `ids`), checked: a cached answer is reused until the CLI, its adapter or its sign-in files
 * change (`stamp`), unless `refresh`. Runs the vendor's own commands, so only a runner's page on `/providers` and an
 * explicit check call it.
 */
export async function checkRunners(
	options: {
		ids?: readonly string[];
		refresh?: boolean;
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		agentDir?: string;
	} = {},
): Promise<RunnerState[]> {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? getAgentDir();
	const cache = readCache(agentDir);
	const specs = options.ids ? RUNNERS.filter((spec) => options.ids!.includes(spec.id)) : RUNNERS;
	const updates: Cache = {};
	const states = await Promise.all(
		specs.map(async (spec) => {
			const found = stamp(spec, env);
			const cached = cache[spec.id];
			if (!options.refresh && cached?.state && cached.stamp === found.key) return cached.state;
			const state = await check(spec, found, env, options.signal);
			if (!options.signal?.aborted) updates[spec.id] = { stamp: found.key, state, revision: cached?.revision };
			return state;
		}),
	);
	if (!options.signal?.aborted)
		await updateCache(
			agentDir,
			(current) => {
				for (const [id, entry] of Object.entries(updates)) {
					if (current[id]?.revision === entry.revision) current[id] = entry;
				}
			},
			options.signal,
		);
	return states;
}

/**
 * Every known runner as far as it is known without starting anything: on PATH or not, and its cached check while that
 * still holds; one never checked (or changed since) has no `checkedAt`.
 */
export function listRunners(env: NodeJS.ProcessEnv = process.env, agentDir: string = getAgentDir()): RunnerState[] {
	const cache = readCache(agentDir);
	return RUNNERS.map((spec) => {
		const found = stamp(spec, env);
		const cached = cache[spec.id];
		if (cached?.state && cached.stamp === found.key) return cached.state;
		return { id: spec.id, name: spec.name, cli: Boolean(found.cli), adapter: Boolean(found.adapter) };
	});
}

/** The runners whose cached check still holds (nothing changed since), read without starting anything. */
export function cachedRunners(env: NodeJS.ProcessEnv = process.env, agentDir: string = getAgentDir()): RunnerState[] {
	const cache = readCache(agentDir);
	return RUNNERS.flatMap((spec) => {
		const cached = cache[spec.id];
		return cached?.state && cached.stamp === stamp(spec, env).key ? [cached.state] : [];
	});
}

/**
 * A runner a task can name: signed in at its last check, and runnable either through its ACP adapter or, for Claude Code
 * without one, headless through its own CLI (`runner-headless.ts`).
 */
export const isConnected = (state: RunnerState): boolean =>
	(state.cli && state.adapter && state.auth?.signedIn === true) || headlessReady(state);

/** Forgets a runner's cached check (its run was refused as signed out): the next check runs its commands again. */
export async function forgetRunner(id: string, agentDir: string = getAgentDir()): Promise<void> {
	if (!RUNNERS.some((spec) => spec.id === id)) return;
	await updateCache(agentDir, (cache) => {
		// Keep the invalidation across processes, including when a first check is still in flight.
		cache[id] = { stamp: "", revision: randomUUID() };
	});
}
