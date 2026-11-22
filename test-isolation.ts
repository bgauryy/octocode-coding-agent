import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { processRow, type ProcessRow, visitProcesses } from "./test-process-list.ts";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";

/**
 * The isolation every test run gets before its first worker or test process starts: its own temporary root, its own home
 * when the run was started with the developer's real one, and the markers that let `agentDbPath` refuse the real agent
 * database in every process the run starts. Used by `vitest.tmp.global.ts` (every Vitest configuration) and the TUI's
 * node:test global setup. Imports only Node built-ins: it also runs outside Vitest.
 */

/** Mirror `TEST_GUARD_FILE_ENV` and `TEST_PROTECTED_HOMES_ENV` in `packages/coding-agent/src/storage/state-paths.ts`. */
export const GUARD_FILE_ENV = "OCTOCODE_TEST_GUARD_FILE";
export const PROTECTED_HOMES_ENV = "OCTOCODE_TEST_PROTECTED_HOMES";

const OWNER_FILE = ".owner-pid";
// Short on purpose: Unix socket paths inside a test directory are limited to about 104 bytes on macOS.
const PREFIX = "vt-";
/** The hidden CLI subcommand of the web daemon (`web-daemon/launcher.ts`). */
const DAEMON_COMMAND = "__web-daemon";

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** An existing directory can still be acquiring its owner marker in another runner. */
function staleRun(parent: string, name: string): boolean {
	const dir = join(parent, name);
	let raw: string;
	try {
		raw = readFileSync(join(dir, OWNER_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return !existsSync(dir);
	}
	const pid = Number(raw);
	return Number.isSafeInteger(pid) && pid > 0 && !pidIsAlive(pid);
}

/** The private tmux servers of the e2e suites: `-L <prefix>-<pid of the test process>[-<n>]`. */
const E2E_TMUX_SOCKET = /^(?:octo-e2e|octo-reach)-(\d+)(?:-\d+)?$/;

/** Where tmux keeps the `-L` sockets of this user. */
export const tmuxSocketDir = (env: NodeJS.ProcessEnv = process.env): string =>
	join(env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`);

/**
 * Stops and removes the e2e suites' tmux sockets in `dir` whose test process is gone: tmux leaves the socket file
 * behind when its server is killed, and a run interrupted before its own cleanup leaves the server too. Returns the
 * removed names.
 */
export function sweepStaleTmuxSockets(dir: string = tmuxSocketDir()): string[] {
	if (process.platform === "win32" || !existsSync(dir)) return [];
	const removed: string[] = [];
	for (const name of readdirSync(dir)) {
		const owner = E2E_TMUX_SOCKET.exec(name)?.[1];
		if (owner === undefined || pidIsAlive(Number(owner))) continue;
		const socket = join(dir, name);
		// Fails without a live server (or without tmux, which then started none): the file is all that is left.
		spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
		rmSync(socket, { force: true });
		removed.push(name);
	}
	return removed;
}

/**
 * Removes what a run killed before its teardown left under `parent`: first the processes it left running, then its
 * folders. Its teardown never ran, so nothing else stops them, and some cannot carry the run's marker (tmux started
 * with `env -i`, a grandchild that only shares the process group).
 */
export async function sweepStaleRunDirs(parent: string): Promise<void> {
	await stopStaleRunOrphans(parent);
	for (const name of readdirSync(parent)) {
		if (!name.startsWith(PREFIX)) continue;
		const dir = join(parent, name);
		if (staleRun(parent, name)) rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Orphaned processes (re-parented to pid 1) whose command line or environment names a folder of a run that is no longer
 * alive under `parent`. The group and start stamp identify the candidate again before signalling it.
 */
export async function staleRunOrphans(parent: string, listing?: string, pids?: readonly number[]): Promise<Orphan[]> {
	if (process.platform === "win32") return [];
	const roots = [...new Set([parent, realpathOr(parent)])].map((each) => each.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const folder = new RegExp(`(?:${roots.join("|")})/(${PREFIX}[A-Za-z0-9]+)`, "g");
	const found: Orphan[] = [];
	const visit = ({ pid, ppid, pgid, started, command }: ProcessRow) => {
		if (ppid !== 1 || pid === process.pid) return;
		const names = new Set<string>();
		for (const match of command.matchAll(folder)) {
			if (!names.has(match[1]) && !staleRun(parent, match[1])) return;
			names.add(match[1]);
		}
		if (names.size > 0) found.push({ pid, pgid, started });
	};
	if (listing !== undefined) {
		for (const line of listing.split("\n")) {
			const row = processRow(line);
			if (row) visit(row);
		}
	} else {
		// Most processes have a live parent; skip their environments altogether.
		const orphans: number[] = [];
		await visitProcesses(
			false,
			({ pid, ppid }) => {
				if (ppid === 1 && pid !== process.pid) orphans.push(pid);
			},
			pids,
		);
		await visitProcesses(true, visit, orphans);
	}
	return found;
}

type Orphan = Pick<ProcessRow, "pid" | "pgid" | "started">;

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Stops `staleRunOrphans`: their whole process group when they lead it, TERM first, then KILL; again for new orphans. */
async function stopStaleRunOrphans(parent: string): Promise<void> {
	for (let pass = 0; pass < 3; pass++) {
		const orphans = await staleRunOrphans(parent);
		if (orphans.length === 0) return;
		const initial = new Map(orphans.map((each) => [each.pid, each]));
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			const current = await staleRunOrphans(parent, undefined, [...initial.keys()]);
			for (const { pid, pgid, started } of current) {
				const owned = initial.get(pid);
				if (owned?.started !== started || owned.pgid !== pgid) continue;
				try {
					process.kill(pgid === pid ? -pgid : pid, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			if (signal === "SIGTERM" && current.length) await pause(500);
		}
	}
}

/** A new run folder under `parent`, owned by this process so a later run's sweep keeps it while this run lives. */
export function makeRunDir(parent: string): string {
	const dir = mkdtempSync(join(parent, PREFIX));
	writeFileSync(join(dir, OWNER_FILE), String(process.pid));
	return dir;
}

const inside = (parent: string, path: string): boolean => {
	const rel = relative(parent, path);
	return !rel.startsWith("..") && !isAbsolute(rel);
};

function accountHome(): string | undefined {
	try {
		return userInfo().homedir;
	} catch {
		return undefined;
	}
}

interface HomeIsolation {
	/** Whether the run came with its own home (`./test.sh`, CI) and kept it. */
	kept: boolean;
	/** The homes `agentDbPath` refuses in this run's processes. */
	protectedHomes: string[];
}

/**
 * Points `env` away from the developer's homes. A run whose `HOME` is already elsewhere (`./test.sh`) keeps it and only
 * replaces a variable that still names a protected home; a run started with the real home gets `home`, and every
 * variable below is set to its default under that home or removed, so no process the run starts falls back to the
 * developer's folders. The protected homes are the account's, the starting `HOME` and any an outer run named.
 */
export function isolateHome(env: NodeJS.ProcessEnv, home: () => string): HomeIsolation {
	const listed = (env[PROTECTED_HOMES_ENV] ?? "").split(delimiter).filter(Boolean);
	const known = [...new Set([accountHome(), ...listed].filter((each): each is string => Boolean(each)))];
	const protects = (value: string) => known.some((each) => inside(each, resolve(value)));
	const startHome = env.HOME?.trim() ? resolve(env.HOME.trim()) : undefined;
	const kept = startHome !== undefined && !protects(startHome);
	if (startHome && !kept) known.push(startHome);
	const base = kept ? startHome : home();
	const octocodeHome = join(base, ".octocode", "octocodecode");
	const defaults: Record<string, string | undefined> = {
		XDG_CONFIG_HOME: join(base, ".config"),
		XDG_CACHE_HOME: join(base, ".cache"),
		XDG_DATA_HOME: undefined,
		XDG_STATE_HOME: undefined,
		OCTOCODE_HOME: octocodeHome,
		OCTOCODE_CODING_AGENT_DIR: octocodeHome,
		OCTOCODE_AGENT_DB: join(octocodeHome, "agent", "workspaces.db"),
		CLAUDE_CONFIG_DIR: undefined,
		CODEX_HOME: undefined,
	};
	if (!kept) {
		env.HOME = base;
		env.USERPROFILE = base;
	}
	for (const [name, value] of Object.entries(defaults)) {
		const current = env[name]?.trim();
		if (kept && (!current || !protects(current))) continue;
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	const protectedHomes = [...new Set(known)];
	env[PROTECTED_HOMES_ENV] = protectedHomes.join(delimiter);
	return { kept, protectedHomes };
}

/** The refusals `agentDbPath` recorded in the run's guard file (file, pid, caller), from any process of the run. */
export function guardRecords(file: string): string[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

interface RunProcess {
	pid: number;
	started: string;
	command: string;
}

/**
 * Processes, other than this one and its direct children (the runner's workers), whose environment carries `marker`
 * (`OCTOCODE_TEST_GUARD_FILE=<this run's file>`): what the run's tests started, daemons included. Read with `ps`, which
 * shows another process's environment only for the same user; empty on Windows.
 */
export async function runProcesses(marker: string, pids?: readonly number[]): Promise<RunProcess[]> {
	if (process.platform === "win32") return [];
	const prefix = GUARD_FILE_ENV + "=";
	if (!marker.startsWith(prefix) || marker.length === prefix.length || /[\r\n\0]/.test(marker))
		throw new Error("Expected a nonempty test-run guard marker.");
	const field = " " + marker;
	const key = " " + prefix;
	const owners = new Map<number, string>();
	await visitProcesses(
		true,
		({ pid, ppid, started, command }) => {
			if (pid === process.pid || ppid === process.pid) return;
			const at = command.indexOf(key);
			if (at < 0 || command.indexOf(key, at + 1) >= 0) return;
			if (command.startsWith(field, at) && (at + field.length === command.length || command[at + field.length] === " "))
				owners.set(pid, started);
		},
		pids,
	);
	const found: RunProcess[] = [];
	// Only the unmarked argv snapshot can label a process. Reject a guard in argv, a reused pid or a direct child.
	await visitProcesses(
		false,
		({ pid, ppid, started, command }) => {
			if (owners.get(pid) !== started || ppid === process.pid || command.includes(prefix)) return;
			const executable = basename(command.split(" ", 1)[0]);
			const daemon = command.split(/\s+/).includes(DAEMON_COMMAND);
			found.push({ pid, started, command: daemon ? `${executable} ${DAEMON_COMMAND}` : executable });
		},
		[...owners.keys()],
	);
	return found;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits while the run's processes keep exiting; returns once none is left or none exited for `quietMs`. */
async function settle(marker: string, quietMs: number): Promise<RunProcess[]> {
	let left = await runProcesses(marker);
	let lastChange = Date.now();
	while (left.length > 0 && Date.now() - lastChange < quietMs) {
		await pause(200);
		const now = await runProcesses(marker);
		if (now.length !== left.length) lastChange = Date.now();
		left = now;
	}
	return left;
}

async function signal(marker: string, processes: RunProcess[], name: NodeJS.Signals): Promise<void> {
	const owners = new Map(processes.map((each) => [each.pid, each.started]));
	for (const { pid, started } of await runProcesses(marker, [...owners.keys()])) {
		if (owners.get(pid) !== started) continue;
		try {
			process.kill(pid, name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

/**
 * Stops what the run left running once its tests are done: processes that are still exiting get time while they make
 * progress, then the rest get SIGTERM and finally SIGKILL. Returns what was found still running, daemons apart.
 */
export async function stopRunProcesses(marker: string): Promise<{ daemons: RunProcess[]; others: RunProcess[] }> {
	const left = await settle(marker, 2000);
	if (left.length > 0) {
		await signal(marker, left, "SIGTERM");
		await signal(marker, await settle(marker, 3000), "SIGKILL");
		await settle(marker, 1000);
	}
	return {
		daemons: left.filter((each) => each.command.includes(DAEMON_COMMAND)),
		others: left.filter((each) => !each.command.includes(DAEMON_COMMAND)),
	};
}
