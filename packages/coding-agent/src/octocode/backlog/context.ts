import type { ExtensionContext } from "../../core/features/index.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "../../../../common/src/env.ts";
import { historyWindows } from "../../storage/retention.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { sessionWorkspace } from "../shared/home/workspace.ts";
import { type Actor, BacklogStore } from "./store.ts";
import { scheduleHistoryArchive } from "../../../../db/src/api.ts";

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

/** A workspace owns its board. A child delegated an item works on the board that issued it. */
export function openBacklog(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, options: BacklogOptions): Backlog {
	const env = options.env ?? process.env;
	const agent = sharedAgentDb(env);
	const cwd = options.isSubagent && env[BACKLOG_ITEM_ENV] ? sessionWorkspace(ctx.cwd, env) : ctx.cwd;
	const workspace = registeredWorkspace(cwd, agent);
	const store = new BacklogStore(() => agent, workspace.id);
	const session = ctx.sessionManager.getSessionId();
	if (!options.isSubagent) {
		// Daily history housekeeping (the parent session runs it; its subagents share the database).
		scheduleHistoryArchive(
			() => agent,
			() => historyWindows(env),
		);
		return {
			store,
			actor: { id: session, surface: "tool" },
			session,
			repoName: workspace.name,
			repoRoot: workspace.root,
		};
	}
	const id = options.agentId?.() || session;
	// A subagent never claims: it may update only what the session that started it holds (named by the parent, not inferred).
	const parent = env[PARENT_SESSION_ENV];
	if (!parent)
		throw new Error(
			`This subagent's parent session is unknown (${PARENT_SESSION_ENV} is unset), so no backlog item is its coordinator's to update: report changes and proposals to your coordinator.`,
		);
	const item = env[BACKLOG_ITEM_ENV];
	const actor: Actor = { id, surface: "tool", owners: new Set([parent]), ...(item ? { item } : {}) };
	return { store, actor, session, repoName: workspace.name, repoRoot: workspace.root };
}

/** The user acting from `/backlog`: the session's actor as a human, recorded in the audit with the command surface. */
export const userActor = (backlog: Backlog): Actor => ({ ...backlog.actor, kind: "human", surface: "command" });

export interface BacklogWeb {
	url: string;
	close(): Promise<void>;
	/** Revalidate a cached shared endpoint before opening it again; omitted for ordinary per-session servers. */
	validate?: () => Promise<boolean>;
	/** Whether this server, started by this process, still accepts connections; lets a wrapper skip a loopback probe. */
	isUp?: () => boolean;
}

export type OpenBacklogWeb = (ctx: ExtensionContext, backlog: Backlog, changed: () => void) => Promise<BacklogWeb>;
