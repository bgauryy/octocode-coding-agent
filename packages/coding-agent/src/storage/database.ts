import path from "node:path";
import {
	type AgentDb,
	type DbWriter,
	openDatabase,
	prepareSharedDatabase,
	isBusy,
	sharedDatabase,
	sharedDbWriter,
	sharedMirrorWriter,
} from "../../../db/src/api.ts";
/** Waits (bounded) for queued database writes: call before `process.exit`, which skips the exit drain. */
export { drainDbWriters } from "../../../db/src/api.ts";
import { agentDbPath, globalPaths, transcriptDbPath } from "./state-paths.ts";

function locations(file: string, env: NodeJS.ProcessEnv) {
	const paths = globalPaths(env);
	return {
		file,
		mirrorFile: transcriptDbPath(file),
		archiveDir: path.join(paths.home, "archive"),
		privateParent: path.dirname(file) === paths.agentState,
	};
}

/** Open an independent connection using this host's configuration. The caller owns it. */
export function openAgentDb(file?: string, env: NodeJS.ProcessEnv = process.env): AgentDb {
	return openDatabase(locations(file ?? agentDbPath(env), env));
}

/** Process-owned connection shared by every workspace using the configured database. */
export function sharedAgentDb(env: NodeJS.ProcessEnv = process.env): AgentDb {
	return sharedDatabase(locations(agentDbPath(env), env));
}

/** Prepare coordination before synchronous startup consumers; keep their existing diagnostics for unusable files. */
export async function prepareAgentDb(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<void> {
	try {
		await prepareSharedDatabase(locations(agentDbPath(env), env), { signal });
	} catch (error) {
		// A busy deadline or cancellation must not fall straight into another synchronous five-second open attempt.
		if (isBusy(error) || signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
	}
}

/** The process's writer for the configured database's bookkeeping (memory use marks, session stats): off the main thread. */
export function sharedAgentDbWriter(env: NodeJS.ProcessEnv = process.env): DbWriter {
	return sharedDbWriter(locations(agentDbPath(env), env));
}

/** The process's bookkeeping writer for the database `agent` has open (`openAgentDb` or any other file). */
export function agentDbWriter(agent: AgentDb): DbWriter {
	const { file, mirrorFile, archiveDir } = agent;
	return sharedDbWriter({ file, mirrorFile, archiveDir, privateParent: false });
}

/** The process's writer for the configured database's transcript mirror (`transcripts.db`): off the main thread. */
export function sharedTranscriptWriter(env: NodeJS.ProcessEnv = process.env): DbWriter {
	return sharedMirrorWriter(locations(agentDbPath(env), env));
}
