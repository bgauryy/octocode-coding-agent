import type { ExtensionContext, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { sharedAgentDb } from "../agentdb/api.ts";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "../../../../common/src/env.ts";
import { repoKey } from "../shared/home/repo.ts";
import { type Actor, BacklogStore } from "./store.ts";
import { scheduleHistoryArchive } from "./retention.ts";

export interface BacklogOptions {
	isSubagent: boolean;
	/** This subagent's team id (the author of its notes); its session id is used when unset. */
	agentId?: () => string | undefined;
	env?: NodeJS.ProcessEnv;
}

export interface Backlog {
	store: BacklogStore;
	actor: Actor;
	/** This session's id: the assignee its own claims carry. */
	session: string;
	repoName: string;
	/** The checkout root whose `.octocode/` report folders the workspace board may serve. */
	repoRoot: string;
}

/** The backlog of `ctx.cwd`'s repository (worktrees share their main repository's) and who is acting in it. */
export function openBacklog(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, options: BacklogOptions): Backlog {
	const repo = repoKey(ctx.cwd);
	const env = options.env ?? process.env;
	const store = new BacklogStore(() => sharedAgentDb(env), repo.key);
	const session = ctx.sessionManager.getSessionId();
	if (!options.isSubagent) {
		// Daily history housekeeping (the parent session runs it; its subagents share the database).
		scheduleHistoryArchive(() => sharedAgentDb(env));
		return { store, actor: { id: session }, session, repoName: repo.name, repoRoot: repo.root };
	}
	const id = options.agentId?.() || session;
	// A subagent never claims: it may update only what the session that started it holds (named by the parent, not inferred).
	const parent = env[PARENT_SESSION_ENV];
	if (!parent)
		throw new Error(
			`This subagent's parent session is unknown (${PARENT_SESSION_ENV} is unset), so no backlog item is its parent's to update: report changes and proposals to your parent.`,
		);
	const item = env[BACKLOG_ITEM_ENV];
	const actor: Actor = { id, owners: new Set([parent]), ...(item ? { item } : {}) };
	return { store, actor, session, repoName: repo.name, repoRoot: repo.root };
}

export interface BacklogWeb {
	url: string;
	close(): Promise<void>;
	/** Revalidate a cached shared endpoint before opening it again; omitted for ordinary per-session servers. */
	validate?: () => Promise<boolean>;
	/** Whether this server, started by this process, still accepts connections; lets a wrapper skip a loopback probe. */
	isUp?: () => boolean;
}

export type OpenBacklogWeb = (
	ctx: ExtensionCommandContext,
	backlog: Backlog,
	changed: () => void,
) => Promise<BacklogWeb>;
