import fs from "node:fs";
import path from "node:path";
import {
	type AgentDb,
	type Db,
	type WorkspaceGit,
	type WorkspaceIdentity,
	isBusy,
	transactionWhenReady,
	withoutWaiting,
	workspaces,
} from "../../../db/src/api.ts";
import { workspaceGit } from "../utils/git-repository.ts";
import { openWorkspaceFile, sharedAgentDb, sharedWorkspaceFile, workspaceFilesDir } from "./database.ts";
import { workspaceIdentity } from "./workspace.ts";

type Registration = WorkspaceIdentity & { git?: WorkspaceGit | null };

const registration = (source: string | WorkspaceIdentity): Registration => {
	const identity = typeof source === "string" ? workspaceIdentity(source) : source;
	return { ...identity, git: workspaceGit(identity.root) };
};

/** Bind the on-disk declaration to this database before reading or writing workspace-owned records. */
export function registeredWorkspace(
	source: string | WorkspaceIdentity,
	agent: AgentDb = sharedAgentDb(),
): WorkspaceIdentity {
	const workspace = registration(source);
	workspaces.register(agent.db, workspace);
	return identityOf(workspace);
}

const identityOf = ({ id, root, name, binding }: Registration): WorkspaceIdentity => ({ id, root, name, binding });

/** The usual unchanged registration stays a read; only a contended metadata write waits asynchronously. */
async function registerWhenReady(agent: AgentDb, workspace: Registration, signal?: AbortSignal): Promise<void> {
	try {
		withoutWaiting(agent.db, () => workspaces.register(agent.db, workspace));
	} catch (error) {
		if (!isBusy(error)) throw error;
		await transactionWhenReady(agent, () => workspaces.register(agent.db, workspace), signal);
	}
}

/** A workspace and the database holding its rows. */
export interface WorkspaceDb {
	agent: AgentDb;
	workspace: WorkspaceIdentity;
}

/** Keys of workspaces this process bound, by machine file and workspace id: a key never changes once claimed. */
const boundKeys = new Map<string, string>();

/**
 * The key of the workspace file holding `workspace`'s rows, registered in `machine`: the key its repository's checkouts
 * share (`workspaces.claimDbKey`), proposing the main checkout's id for a linked worktree, else its own id.
 */
function dbKey(machine: AgentDb, workspace: Registration): string {
	const bound = `${machine.file}\0${workspace.id}`;
	const known = boundKeys.get(bound) ?? workspaces.byId(machine.db, workspace.id)?.dbKey;
	const key =
		known ??
		workspaces.claimDbKey(
			machine.db,
			workspace.id,
			(workspace.git?.linkedWorktree &&
				workspaces
					.inRepository(machine.db, workspace.git.commonDir)
					.find((other) => other.git?.linkedWorktree === false)?.id) ||
				workspace.id,
		);
	if (key === undefined) throw new Error(`Workspace ${workspace.id} is not registered in ${machine.file}.`);
	boundKeys.set(bound, key);
	return key;
}

/** The machine connection each workspace connection was opened from: its session rows live there. */
const machines = new WeakMap<Db, Db>();

/**
 * The connection holding the session rows for `db`: the machine file a workspace connection was opened from, else
 * `db` itself (a machine connection, or any connection while workspace files are off).
 */
export function sessionRowsOf(db: Db): Db {
	return machines.get(db) ?? db;
}

/** The file holding `workspace`'s rows, opened from the machine file it is registered in (`machine`). */
function fileOf(machine: AgentDb, workspace: Registration, env: NodeJS.ProcessEnv): AgentDb {
	if (workspaceFilesDir(machine.file) === undefined) return machine;
	const file = sharedWorkspaceFile(dbKey(machine, workspace), env, machine.file);
	machines.set(file.db, machine.db);
	return file;
}

/**
 * Every workspace file of the machine file `machine` that exists (none while workspace files are off), for work across
 * workspaces: session links, purges, maintenance.
 */
export function everyWorkspaceFile(machine: AgentDb, env: NodeJS.ProcessEnv = process.env): AgentDb[] {
	const dir = workspaceFilesDir(machine.file);
	if (dir === undefined) return [];
	const keys = new Set(workspaces.list(machine.db).flatMap((workspace) => workspace.dbKey ?? []));
	return [...keys]
		.filter((key) => fs.existsSync(path.join(dir, `${key}.db`)))
		.map((key) => {
			const file = sharedWorkspaceFile(key, env, machine.file);
			machines.set(file.db, machine.db);
			return file;
		});
}

/**
 * The database holding the rows of the workspace at `source` (backlog, team, events, jobs, timers, leases, edits, runs),
 * with the workspace registered in it and in the machine file. That is its workspace file, which a linked worktree
 * shares with its main checkout (keeping its own board), or the machine file while workspace files are off
 * (`workspaceFilesDir`). Machine-wide rows (sessions, memories, usage, trust, providers) stay in `sharedAgentDb`.
 */
export function workspaceDb(source: string | WorkspaceIdentity, env: NodeJS.ProcessEnv = process.env): WorkspaceDb {
	const machine = sharedAgentDb(env);
	const workspace = registration(source);
	workspaces.register(machine.db, workspace);
	const agent = fileOf(machine, workspace, env);
	if (agent !== machine) workspaces.register(agent.db, workspace);
	return { agent, workspace: identityOf(workspace) };
}

/**
 * `workspaceDb` on a connection the caller opened on a machine file (`openAgentDb`): an independent connection on the
 * workspace file, which the caller closes, or `machine` itself while workspace files are off.
 */
export function openWorkspaceDb(
	machine: AgentDb,
	source: string | WorkspaceIdentity,
	env: NodeJS.ProcessEnv = process.env,
): WorkspaceDb {
	const workspace = registration(source);
	workspaces.register(machine.db, workspace);
	if (workspaceFilesDir(machine.file) === undefined) return { agent: machine, workspace: identityOf(workspace) };
	const agent = openWorkspaceFile(dbKey(machine, workspace), env, machine.file);
	machines.set(agent.db, machine.db);
	try {
		workspaces.register(agent.db, workspace);
	} catch (error) {
		agent.close();
		throw error;
	}
	return { agent, workspace: identityOf(workspace) };
}

/** `workspaceDb` where a contended registration waits asynchronously. */
export async function workspaceDbWhenReady(
	source: string | WorkspaceIdentity,
	signal?: AbortSignal,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceDb> {
	signal?.throwIfAborted();
	const machine = sharedAgentDb(env);
	const workspace = registration(source);
	await registerWhenReady(machine, workspace, signal);
	const agent = fileOf(machine, workspace, env);
	if (agent !== machine) await registerWhenReady(agent, workspace, signal);
	return { agent, workspace: identityOf(workspace) };
}

/**
 * The database holding the rows of registered workspace `id`, for a caller holding only its id (a web view, a CLI
 * naming another workspace). Undefined when the machine file has no such workspace.
 */
export function registeredWorkspaceDb(id: string, env: NodeJS.ProcessEnv = process.env): WorkspaceDb | undefined {
	const machine = sharedAgentDb(env);
	const found = workspaces.byId(machine.db, id);
	if (!found) return undefined;
	const workspace: Registration = { ...identityOf({ ...found }), git: found.git };
	const agent = fileOf(machine, workspace, env);
	if (agent !== machine) workspaces.register(agent.db, workspace);
	return { agent, workspace: identityOf(workspace) };
}

/**
 * `registeredWorkspaceDb(id).agent`, for a caller that must have its rows: throws when the machine file has no such
 * workspace, since falling back to the machine file would put that workspace's rows in the wrong file.
 */
export function registeredWorkspaceAgent(id: string, env: NodeJS.ProcessEnv = process.env): AgentDb {
	const found = registeredWorkspaceDb(id, env);
	if (!found) throw new Error(`Workspace ${id} is not registered in ${sharedAgentDb(env).file}.`);
	return found.agent;
}
