import fs from "node:fs";
import path from "node:path";
import type { DaemonRepo } from "@octocodeai/octocode-contracts/daemon";
import { backlog, sharedAgentDb } from "../agentdb/api.ts";
import { BacklogStore } from "../backlog/store.ts";
import { workspaceOctocodeDir } from "../shared/home.ts";
import { repoId, type SessionRegistry } from "./sessions.ts";

export interface RepoInfo {
	id: string;
	key: string;
	name: string;
	/** The checkout whose `.octocode/` report folders may be served; known only for repositories of a live session or derived from the key. */
	root?: string;
	sessions: number;
}

/**
 * The repositories the daemon serves: every `repo_key` with backlog items in the agent database, plus those of attached
 * sessions. Routes name a repository by `repoId`; the id resolves only to a key this catalog holds, so no request can
 * reach a path it did not already index.
 */
export class RepoCatalog {
	private readonly env: NodeJS.ProcessEnv;
	private readonly registry: SessionRegistry;
	constructor(env: NodeJS.ProcessEnv, registry: SessionRegistry) {
		this.env = env;
		this.registry = registry;
	}

	private keys(): string[] {
		try {
			return backlog.repoKeys(sharedAgentDb(this.env).db);
		} catch {
			return [];
		}
	}

	list(): RepoInfo[] {
		const repos = new Map<string, RepoInfo>();
		const live = this.registry.list();
		for (const session of live) {
			const attached = this.registry.get(session.id)?.record.repo;
			if (!attached) continue;
			const existing = repos.get(attached.key);
			if (existing) existing.sessions++;
			else
				repos.set(attached.key, {
					id: repoId(attached.key),
					key: attached.key,
					name: attached.name,
					root: attached.root,
					sessions: 1,
				});
		}
		for (const key of this.keys()) {
			if (repos.has(key)) continue;
			// A git key is the common `.git` folder; without git the key is the root itself.
			const root = path.basename(key) === ".git" ? path.dirname(key) : key;
			repos.set(key, { id: repoId(key), key, name: path.basename(root), root, sessions: 0 });
		}
		return [...repos.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
	}

	resolve(id: string): RepoInfo | undefined {
		return this.list().find((repo) => repo.id === id);
	}

	summaries(): DaemonRepo[] {
		return this.list().map((repo) => ({
			id: repo.id,
			name: repo.name.slice(0, 256),
			sessions: repo.sessions,
			hasReports: repo.root !== undefined && fs.existsSync(workspaceOctocodeDir(repo.root)),
		}));
	}

	store(key: string): BacklogStore {
		return new BacklogStore(() => sharedAgentDb(this.env), key);
	}
}
