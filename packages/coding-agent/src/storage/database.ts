import path from "node:path";
import { type AgentDb, type DbWriter, openDatabase, sharedDatabase, sharedDbWriter } from "../../../db/src/api.ts";
import { agentDbPath, globalPaths } from "./state-paths.ts";

function locations(file: string, env: NodeJS.ProcessEnv) {
	const paths = globalPaths(env);
	return { file, archiveDir: path.join(paths.home, "archive"), privateParent: path.dirname(file) === paths.agentState };
}

/** Open an independent connection using this host's configuration. The caller owns it. */
export function openAgentDb(file?: string, env: NodeJS.ProcessEnv = process.env): AgentDb {
	return openDatabase(locations(file ?? agentDbPath(env), env));
}

/** Process-owned connection shared by every workspace using the configured database. */
export function sharedAgentDb(env: NodeJS.ProcessEnv = process.env): AgentDb {
	return sharedDatabase(locations(agentDbPath(env), env));
}

/** The process's database writer for the configured database: derived writes off the main thread (session mirror). */
export function sharedAgentDbWriter(env: NodeJS.ProcessEnv = process.env): DbWriter {
	return sharedDbWriter(locations(agentDbPath(env), env));
}
