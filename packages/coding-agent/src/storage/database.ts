import path from "node:path";
import {
	type AgentDb,
	type DatabaseLocations,
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
import { sameProcess } from "../octocode/shared/process.ts";
import { agentDbPath, checkedAgentDbPath, globalPaths, transcriptDbPath, workspaceDbDir } from "./state-paths.ts";

/**
 * Whether workspace rows live in workspace files: on, the first open of a machine file splits it (`schema-split.ts`).
 * `OCTOCODE_TEST_WORKSPACE_FILES` (`1` or `0`) overrides it for one process, so tests run both layouts on isolated homes.
 */
const WORKSPACE_FILES = true;

/** The folder of the machine file's workspace files, or undefined while workspace rows stay in the machine file. */
export function workspaceFilesDir(file: string): string | undefined {
	if (splitDeferred.has(file)) return undefined;
	const forced = process.env.OCTOCODE_TEST_WORKSPACE_FILES;
	return (forced === undefined ? WORKSPACE_FILES : forced === "1") ? workspaceDbDir(file) : undefined;
}

/**
 * Why this process kept the un-split layout: the split was put off while another session's process ran. Decided once
 * per process, so every open agrees on where workspace rows live; the next process that starts alone splits.
 */
const splitDeferred = new Map<string, string>();

/** The put-off split's reason for the configured machine file, for the session's startup notice. */
export const deferredSplit = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
	splitDeferred.get(agentDbPath(env));

/** The split's test for another session's process (`DatabaseLocations.split`): its pid with its recorded start time. */
const split = (file: string) => ({
	running: (pid: number, started: string | null) => sameProcess(pid, started),
	deferred: (reason: string) => void splitDeferred.set(file, reason),
});

/**
 * Where the database at `file` keeps its parts; a test that names the real home's file directly is refused too. With
 * workspace files on, an open runs a pending split of the machine file.
 */
function locations(file: string, env: NodeJS.ProcessEnv): DatabaseLocations {
	checkedAgentDbPath(file, env);
	const paths = globalPaths(env);
	const workspaceDir = workspaceFilesDir(file);
	return {
		file,
		mirrorFile: transcriptDbPath(file),
		archiveDir: path.join(paths.home, "archive"),
		privateParent: path.dirname(file) === paths.agentState,
		...(workspaceDir === undefined ? {} : { workspaceDir, split: split(file) }),
	};
}

/**
 * The workspace file of `key` beside the machine file `machine`: the machine file's mirror and archive, and its name on
 * archived history, so a repository's history stays one stream across the split.
 */
function workspaceLocations(machine: string, key: string, env: NodeJS.ProcessEnv): DatabaseLocations {
	const dir = workspaceFilesDir(machine);
	if (dir === undefined) throw new Error("Workspace files are off: workspace rows live in the machine file.");
	const { mirrorFile, archiveDir } = locations(machine, env);
	const file = checkedAgentDbPath(path.join(dir, `${key}.db`), env);
	return { file, mirrorFile, archiveDir, privateParent: false, workspace: key, historySource: machine };
}

/** The process's connection on the workspace file of `key` beside `machine` (default: the configured machine file). */
export function sharedWorkspaceFile(key: string, env: NodeJS.ProcessEnv = process.env, machine?: string): AgentDb {
	return sharedDatabase(workspaceLocations(machine ?? agentDbPath(env), key, env));
}

/** An independent connection on the workspace file of `key` beside `machine` (default: the configured one). */
export function openWorkspaceFile(key: string, env: NodeJS.ProcessEnv = process.env, machine?: string): AgentDb {
	return openDatabase(workspaceLocations(machine ?? agentDbPath(env), key, env));
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
	const { file, mirrorFile, archiveDir, workspace, historySource, workspaceDir } = agent;
	return sharedDbWriter({ file, mirrorFile, archiveDir, privateParent: false, workspace, historySource, workspaceDir });
}

/** The process's writer for the configured database's transcript mirror (`transcripts.db`): off the main thread. */
export function sharedTranscriptWriter(env: NodeJS.ProcessEnv = process.env): DbWriter {
	return sharedMirrorWriter(locations(agentDbPath(env), env));
}
