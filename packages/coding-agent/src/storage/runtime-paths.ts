import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateDir } from "../../../common/src/file-mode.ts";
import { globalPaths } from "./state-paths.ts";
import { ensureWorkspaceStateDir, workspaceStateDir } from "./workspace.ts";

/**
 * A session id as a folder name. An empty id or one made only of dots (`.`, `..`) would name the sessions folder or
 * its parent, so it is refused; every other id keeps the name it always had, so no saved data is orphaned.
 */
export function sessionDirName(id: string): string {
	const name = id.replace(/[^\w.-]/g, "_");
	if (/^\.*$/.test(name)) throw new Error(`Invalid session id ${JSON.stringify(id)}: it cannot name a session folder.`);
	return name;
}

interface SessionLocation {
	id?: string;
	cwd?: string;
}
const locations = new WeakMap<object, SessionLocation>();
const active = new AsyncLocalStorage<SessionLocation>();
let foreground: SessionLocation = {};

/** Bind a native session. A later switch replaces its location while in-flight callbacks retain their original scope. */
export function setCurrentSession(id: string | undefined, cwd?: string, manager?: object): void {
	foreground = id?.trim() ? { id, cwd } : {};
	if (manager) locations.set(manager, foreground);
}

/** Keep one tool, hook or command and all of its async continuations in their initiating workspace. */
export function withSessionStorage<T>(manager: object | undefined, run: () => T): T {
	return active.run(manager ? (locations.get(manager) ?? {}) : foreground, run);
}

export const currentSessionId = (): string | undefined => (active.getStore() ?? foreground).id;
export const currentSessionWorkspace = (): string | undefined => (active.getStore() ?? foreground).cwd;

/** Tool and UI scratch for an active workspace; host utilities without a session use their normal OS temporary directory. */
export function runtimeTempDir(): string {
	return currentSessionWorkspace() ? sessionOutputDir("output") : os.tmpdir();
}

const DURABLE = "session-data";
const TRANSIENT = path.join("temp", "sessions");

/** A process used without a workspace keeps its output in its own configured agent home. */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env, cwd = currentSessionWorkspace()): string {
	return cwd ? workspaceStateDir(cwd, DURABLE) : path.join(globalPaths(env).agentState, "sessions");
}

export function sessionTempRoot(env: NodeJS.ProcessEnv = process.env, cwd = currentSessionWorkspace()): string {
	return cwd ? workspaceStateDir(cwd, TRANSIENT) : sessionsRoot(env, cwd);
}

export function sessionDir(id: string, env: NodeJS.ProcessEnv = process.env, cwd = currentSessionWorkspace()): string {
	const name = sessionDirName(id);
	return cwd ? workspaceStateDir(cwd, path.join(DURABLE, name)) : path.join(sessionsRoot(env), name);
}

export function sessionFolderNames(env: NodeJS.ProcessEnv = process.env): string[] {
	return [
		...new Set(
			[sessionsRoot(env), sessionTempRoot(env)].flatMap((root) => {
				try {
					return fs.readdirSync(root);
				} catch {
					return [];
				}
			}),
		),
	];
}

export const PID_SESSION_PREFIX = "_pid-";
type SessionFolder = "output" | "bash" | "checkpoints" | "archive";

function sessionSubdir(kind: SessionFolder, id: string | undefined): string {
	const root = kind === "output" || kind === "bash" ? TRANSIENT : DURABLE;
	return path.join(root, id ? sessionDirName(id) : `${PID_SESSION_PREFIX}${process.pid}`, kind);
}

export function sessionFolder(
	kind: SessionFolder,
	id: string | undefined = currentSessionId(),
	env: NodeJS.ProcessEnv = process.env,
	cwd = currentSessionWorkspace(),
): string {
	const subdir = sessionSubdir(kind, id);
	if (cwd) return workspaceStateDir(cwd, subdir);
	return path.join(sessionsRoot(env), path.basename(path.dirname(subdir)), kind);
}

export function sessionOutputDir(kind: SessionFolder, env: NodeJS.ProcessEnv = process.env): string {
	const cwd = currentSessionWorkspace();
	if (cwd) return ensureWorkspaceStateDir(cwd, sessionSubdir(kind, currentSessionId()));
	const folder = sessionFolder(kind, currentSessionId(), env);
	privateDir(path.dirname(path.dirname(folder)));
	privateDir(path.dirname(folder));
	return privateDir(folder);
}
