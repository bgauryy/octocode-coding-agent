import fs from "node:fs";
import type { DaemonRepo } from "@octocodeai/octocode-contracts/daemon";
import { workspaces } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { registeredWorkspaceAgent } from "../../storage/workspace-database.ts";
import { isCurrentWorkspace } from "../../storage/workspace.ts";
import { BacklogStore } from "../backlog/store.ts";
import { workspaceAgentDir } from "../shared/home.ts";
import type { SessionRegistry } from "./sessions.ts";

export interface RepoInfo {
	id: string;
	name: string;
	root?: string;
	sessions: number;
}

export class RepoCatalog {
	private readonly env: NodeJS.ProcessEnv;
	private readonly registry: SessionRegistry;
	constructor(env: NodeJS.ProcessEnv, registry: SessionRegistry) {
		this.env = env;
		this.registry = registry;
	}

	private live(): Map<string, RepoInfo> {
		const entries = new Map<string, RepoInfo>();
		for (const { repoId, repoName } of this.registry.list()) {
			const previous = entries.get(repoId);
			if (previous) previous.sessions++;
			else entries.set(repoId, { id: repoId, name: repoName, sessions: 1 });
		}
		return entries;
	}

	/** A missing checkout keeps its board. Only its bound directory can supply files to the web interface. */
	resolve(id: string): RepoInfo | undefined {
		const live = this.live().get(id);
		try {
			const row = workspaces.byId(sharedAgentDb(this.env).db, id);
			if (row)
				return {
					id,
					name: row.name,
					sessions: live?.sessions ?? 0,
					root: isCurrentWorkspace(row) ? row.root : undefined,
				};
		} catch {
			// Attached sessions can still be reached when the database is unavailable.
		}
		return live;
	}

	summaries(): DaemonRepo[] {
		const live = this.live();
		const entries = new Map<string, DaemonRepo>();
		for (const item of live.values()) entries.set(item.id, { ...item, hasReports: false });
		try {
			for (const row of workspaces.list(sharedAgentDb(this.env).db)) {
				entries.set(row.id, {
					id: row.id,
					name: row.name.slice(0, 256),
					sessions: live.get(row.id)?.sessions ?? 0,
					hasReports: fs.existsSync(workspaceAgentDir(row.root)) && isCurrentWorkspace(row),
				});
			}
		} catch {
			// Serve attached sessions when the persistent catalog cannot be read.
		}
		return [...entries.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
	}

	/** The board of registered workspace `id`, in its workspace's file. */
	store(id: string): BacklogStore {
		return new BacklogStore(() => registeredWorkspaceAgent(id, this.env), id);
	}
}
