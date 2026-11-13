import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getOctocodeHome } from "../config.ts";

/** Entry names under the Octocode home. On-disk names are kept stable: existing files must keep resolving. */
export const HOME_NAMES = {
	skills: "skills",
	agents: "agents",
	hooks: "hooks.json",
	team: "team",
	api: "api",
	worktrees: "worktrees",
	/** Global database and runtime files for sessions without a workspace. */
	agentState: "agent",
	/** The octocode-agents-communication package's folder: `communication.sqlite` holds its sessions, messages and path leases. */
	peerCommunication: "agents-communication",
} as const;

type GlobalPaths = { readonly [K in keyof typeof HOME_NAMES]: string } & { readonly home: string };

/** Native state paths; peer communication keeps the external package's shared root. Nothing is created. */
export function globalPaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): GlobalPaths {
	const base = getOctocodeHome(env, home);
	const entries = Object.entries(HOME_NAMES).map(([key, name]) => [key, path.join(base, name)]);
	return {
		home: base,
		...Object.fromEntries(entries),
		peerCommunication: path.join(
			env.OCTOCODE_HOME?.trim() ? base : path.join(home, CONFIG_DIR_NAME),
			HOME_NAMES.peerCommunication,
		),
	} as GlobalPaths;
}

/**
 * The durable agent database (the coordination file): `OCTOCODE_AGENT_DB`, else `<agentState>/workspaces.db`. Nothing is
 * created. Under a test runner it refuses the real home's file (`refuseRealHomeDatabase`).
 */
export function agentDbPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OCTOCODE_AGENT_DB?.trim();
	const file = override ? path.resolve(override) : path.join(globalPaths(env).agentState, "workspaces.db");
	refuseRealHomeDatabase(file, env);
	return file;
}

/**
 * The transcript mirror beside a coordination file: `transcripts.db` beside `workspaces.db`, else `<name>.transcripts.db`
 * beside `<name>.db` (an `OCTOCODE_AGENT_DB` file, a test's file), so two databases in one folder never share a mirror.
 */
export function transcriptDbPath(agentDb: string): string {
	const name = path.basename(agentDb, path.extname(agentDb));
	return path.join(path.dirname(agentDb), name === "workspaces" ? "transcripts.db" : `${name}.transcripts.db`);
}

/**
 * Test-only markers a test run sets before its first worker starts (`vitest.tmp.global.ts`, the TUI's node:test setup).
 * Every process a test starts inherits them, including a detached web daemon, whose environment keeps `OCTOCODE_*`
 * settings but not `VITEST`. The guard file records each refusal; the homes list names the run's real homes besides the
 * account's (the `HOME` the run started with), so a test can only add homes to refuse, never remove one.
 */
export const TEST_GUARD_FILE_ENV = "OCTOCODE_TEST_GUARD_FILE";
export const TEST_PROTECTED_HOMES_ENV = "OCTOCODE_TEST_PROTECTED_HOMES";

const pick = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[name] || process.env[name] || undefined;

/**
 * Inside one of this repository's test runs: its markers, which every test entry point sets and every process it starts
 * inherits. A runner's own variables (`VITEST`, `NODE_TEST_CONTEXT`) do not count: an Octocode a user starts from their
 * own test harness is an ordinary process.
 */
const underTest = (env: NodeJS.ProcessEnv) =>
	Boolean(pick(env, TEST_GUARD_FILE_ENV) || pick(env, TEST_PROTECTED_HOMES_ENV));

/** The account's home from the user database (a test's `HOME` does not change it), and the homes the run protects. */
function protectedHomes(env: NodeJS.ProcessEnv): string[] {
	const homes: string[] = [];
	try {
		homes.push(os.userInfo().homedir);
	} catch {
		// No user database entry: only the run's own list applies.
	}
	for (const value of [env[TEST_PROTECTED_HOMES_ENV], process.env[TEST_PROTECTED_HOMES_ENV]])
		for (const home of value?.split(path.delimiter) ?? []) if (home.trim()) homes.push(path.resolve(home.trim()));
	return homes;
}

const inside = (parent: string, file: string): boolean => {
	const relative = path.relative(parent, file);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * A test must never open the user's real agent database: other live Octocode sessions share it, and a test's rows would
 * stay there. Under a test runner, in its workers and in every process they start, a path inside a protected home's
 * Octocode folder throws, and is recorded in the run's guard file, so the run fails even where a caller catches the
 * error or the process is a detached child (`vitest.tmp.global.ts` reports the file at teardown).
 */
function refuseRealHomeDatabase(file: string, env: NodeJS.ProcessEnv): void {
	if (!underTest(env)) return;
	if (!protectedHomes(env).some((home) => inside(path.join(home, CONFIG_DIR_NAME), file))) return;
	const record = pick(env, TEST_GUARD_FILE_ENV);
	if (record) {
		try {
			fs.appendFileSync(
				record,
				`${file}\t${process.pid}\t${new Error("caller").stack?.split("\n").slice(2, 8).join(" | ")}\n`,
			);
		} catch {
			// The throw below still fails the caller.
		}
	}
	throw new Error(`A test resolved the real agent database (${file}); isolate HOME/OCTOCODE_HOME/OCTOCODE_AGENT_DB.`);
}
