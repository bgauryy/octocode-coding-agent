import { isRecord } from "@octocodeai/octocode-contracts/guards";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileUnlocked, shortHash } from "@octocodeai/octocode-common/atomic-file";
import { withFileLock } from "@octocodeai/octocode-common/file-write-lock";
import { type AgentDb, agentEvents } from "../../../../db/src/api.ts";
import { isCurrentWorkspace, workspaceStateDir } from "../../storage/workspace.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { workspaceRoot } from "../../utils/git-repository.ts";

/** No symlink in the projection path may redirect a workspace write. */
async function checkPath(
	expected: ReturnType<typeof registeredWorkspace>,
	directory: string,
	file: string,
): Promise<void> {
	if (!isCurrentWorkspace(expected)) throw new Error("Workspace path changed; restart before exporting agents.");
	for (const target of [directory, file, `${file}.lock`]) {
		const stat = await fs.promises.lstat(target).catch(() => undefined);
		if (stat?.isSymbolicLink()) throw new Error(`Refusing a symlink in the agents projection: ${target}`);
	}
	if (canonicalPath(directory) !== directory) throw new Error("Agents projection escaped its workspace.");
}

/**
 * Derived cache only. A failed export leaves the committed database intact. The file work (lock, read, atomic write)
 * is asynchronous: the database rows are read on this thread, the disk is never waited on. A lock another process
 * holds fails at once with `ELOCKED` (the lifecycle tries again shortly).
 */
export async function projectAgents(
	agent: AgentDb,
	workspace: string,
	expected: ReturnType<typeof registeredWorkspace> = registeredWorkspace(workspace, agent),
): Promise<void> {
	if (!workspaceRoot(workspace)) return;
	const directory = workspaceStateDir(expected.root);
	const file = path.join(directory, "agents.txt");
	await checkPath(expected, directory, file);
	const storeKey = shortHash(canonicalPath(agent.file));
	// Most commits change other tables: when the view already holds what this database would write, take no lock.
	const wanted = viewContent(agent, expected.id, storeKey);
	if (wanted !== undefined && (await currentView(file)) === wanted) return;
	await withFileLock(file, async (assertHeld) => {
		await checkPath(expected, directory, file);
		const previous = await readView(file, storeKey);
		// Read again under the lock: commits made while waiting for the disk are in this write.
		const content = viewContent(agent, expected.id, storeKey);
		if (content === undefined || content === previous) return; // An empty file cannot carry a database binding.
		await atomicWriteFileUnlocked(file, content, {
			mode: 0o600,
			beforeCommit: async () => {
				await assertHeld();
				await checkPath(expected, directory, file);
			},
		});
	});
}

/** The existing view, checked to be one this database wrote; undefined when there is none. */
async function readView(file: string, storeKey: string): Promise<string | undefined> {
	const stat = await fs.promises.stat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!stat) return undefined;
	if (stat.size > 1024 * 1024) throw new Error("Invalid agents.txt: generated view exceeds 1 MiB.");
	const previous = await fs.promises.readFile(file, "utf8");
	const lines = previous.trim().split("\n");
	if (!previous.trim() || lines.length > 50)
		throw new Error("Invalid agents.txt; remove the generated file to rebuild it.");
	for (const line of lines) {
		const row: unknown = JSON.parse(line);
		if (
			!isRecord(row) ||
			row.version !== 1 ||
			typeof row.id !== "string" ||
			typeof row.time !== "string" ||
			!Number.isFinite(Date.parse(row.time)) ||
			!["name", "parentId", "sessionId"].every((key) => row[key] === null || typeof row[key] === "string") ||
			typeof row.type !== "string" ||
			!(agentEvents.EVENT_TYPES as readonly string[]).includes(row.type) ||
			!isRecord(row.data) ||
			row.data.storeKey !== storeKey
		)
			throw new Error("agents.txt belongs to another database or format; remove the generated file to rebind it.");
	}
	return previous;
}

/** The view's text for the newest events, bound to the database by `storeKey`; undefined when there are none. */
function viewContent(agent: AgentDb, workspace: string, storeKey: string): string | undefined {
	const events = agentEvents.list(agent.db, workspace);
	if (!events.length) return undefined;
	return (
		events
			.map(({ seq: _seq, workspace: _workspace, ...event }) =>
				JSON.stringify({ ...event, data: { ...event.data, storeKey } }),
			)
			.join("\n") + "\n"
	);
}

/** The generated file's text, or undefined when it is missing or too large to be a view. */
async function currentView(file: string): Promise<string | undefined> {
	const stat = await fs.promises.stat(file).catch(() => undefined);
	return stat?.isFile() && stat.size <= 1024 * 1024 ? fs.promises.readFile(file, "utf8") : undefined;
}
