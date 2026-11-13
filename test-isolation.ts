import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

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

function ownerIsAlive(dir: string): boolean {
	try {
		process.kill(Number(readFileSync(join(dir, OWNER_FILE), "utf8")), 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Removes the run folders under `parent` whose owning process is gone (a run killed before its teardown). */
export function sweepStaleRunDirs(parent: string): void {
	for (const name of readdirSync(parent)) {
		if (!name.startsWith(PREFIX)) continue;
		const dir = join(parent, name);
		if (!ownerIsAlive(dir)) rmSync(dir, { recursive: true, force: true });
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
	command: string;
}

/**
 * Processes, other than this one and its direct children (the runner's workers), whose environment carries `marker`
 * (`OCTOCODE_TEST_GUARD_FILE=<this run's file>`): what the run's tests started, daemons included. Read with `ps`, which
 * shows another process's environment only for the same user; empty on Windows.
 */
export function runProcesses(marker: string): RunProcess[] {
	if (process.platform === "win32") return [];
	const env = { ...process.env };
	delete env[GUARD_FILE_ENV];
	const listing = spawnSync("ps", ["axeww", "-o", "pid=,ppid=,command="], {
		encoding: "utf8",
		env,
		maxBuffer: 512 * 1024 * 1024,
	});
	if (listing.status !== 0 || !listing.stdout) return [];
	const pids: number[] = [];
	for (const line of listing.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
		if (!match || !(match[3].includes(`${marker} `) || match[3].endsWith(marker))) continue;
		const pid = Number(match[1]);
		if (pid !== process.pid && Number(match[2]) !== process.pid) pids.push(pid);
	}
	if (pids.length === 0) return [];
	// The command lines again without `e`: the environment can hold credentials and is never printed.
	const commands = spawnSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8", env });
	const found: RunProcess[] = [];
	for (const line of (commands.stdout ?? "").split("\n")) {
		const match = /^\s*(\d+)\s(.*)$/.exec(line);
		if (match && pids.includes(Number(match[1])))
			found.push({ pid: Number(match[1]), command: match[2].slice(0, 300) });
	}
	return found;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits while the run's processes keep exiting; returns once none is left or none exited for `quietMs`. */
async function settle(marker: string, quietMs: number): Promise<RunProcess[]> {
	let left = runProcesses(marker);
	let lastChange = Date.now();
	while (left.length > 0 && Date.now() - lastChange < quietMs) {
		await pause(200);
		const now = runProcesses(marker);
		if (now.length !== left.length) lastChange = Date.now();
		left = now;
	}
	return left;
}

function signal(processes: RunProcess[], name: NodeJS.Signals): void {
	for (const { pid } of processes) {
		try {
			process.kill(pid, name);
		} catch {
			// Already gone.
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
		signal(left, "SIGTERM");
		signal(await settle(marker, 3000), "SIGKILL");
		await settle(marker, 1000);
	}
	return {
		daemons: left.filter((each) => each.command.includes(DAEMON_COMMAND)),
		others: left.filter((each) => !each.command.includes(DAEMON_COMMAND)),
	};
}
