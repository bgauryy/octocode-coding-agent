import { isRecord } from "@octocodeai/octocode-contracts/guards";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, shortHash } from "../../../../common/src/atomic-file.ts";
import { withFileLockSync } from "../../../../common/src/file-write-lock.ts";
import { type AgentDb, agentEvents } from "../agentdb/api.ts";
import { workspacePaths } from "../shared/home.ts";
import { canonicalPath, workspaceRoot } from "../shared/home/repo.ts";

/** No symlink in the projection path may redirect a workspace write. */
function checkPath(workspace: string, directory: string, file: string): void {
	if (canonicalPath(workspace) !== workspace)
		throw new Error("Workspace path changed; restart before exporting agents.");
	for (const target of [directory, file, `${file}.lock`]) {
		if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error(`Refusing a symlink in the agents projection: ${target}`);
	}
	if (canonicalPath(directory) !== directory) throw new Error("Agents projection escaped its workspace.");
}

/** Derived cache only. A failed export leaves the committed database intact. */
export function projectAgents(agent: AgentDb, workspace: string): void {
	if (!workspaceRoot(workspace)) return;
	const directory = workspacePaths(workspace).dir;
	const file = path.join(directory, "agents.txt");
	checkPath(workspace, directory, file);
	fs.mkdirSync(directory, { recursive: true });
	withFileLockSync(
		file,
		(assertHeld) => {
			checkPath(workspace, directory, file);
			const storeKey = shortHash(canonicalPath(agent.file));
			let previous: string | undefined;
			if (fs.existsSync(file)) {
				if (fs.statSync(file).size > 1024 * 1024) throw new Error("Invalid agents.txt: generated view exceeds 1 MiB.");
				previous = fs.readFileSync(file, "utf8");
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
						throw new Error(
							"agents.txt belongs to another database or format; remove the generated file to rebind it.",
						);
				}
			}
			const events = agentEvents.list(agent.db, workspace);
			if (!events.length) return; // An empty file cannot carry a database binding.
			const content =
				events
					.map(({ seq: _seq, workspace: _workspace, ...event }) =>
						JSON.stringify({ ...event, data: { ...event.data, storeKey } }),
					)
					.join("\n") + "\n";
			if (content === previous) return;
			atomicWriteFileSync(file, content, {
				mode: 0o600,
				beforeCommit: () => {
					assertHeld();
					checkPath(workspace, directory, file);
				},
			});
		},
		{ attempts: 1 },
	);
}
