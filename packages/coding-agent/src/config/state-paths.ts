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

/** The durable agent database: `OCTOCODE_AGENT_DB`, else `<agentState>/workspaces.db`. Nothing is created. */
export function agentDbPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OCTOCODE_AGENT_DB?.trim();
	return override ? path.resolve(override) : path.join(globalPaths(env).agentState, "workspaces.db");
}
