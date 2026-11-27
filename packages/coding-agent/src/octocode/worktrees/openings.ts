import { type AgentDb, type Opening, openings } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { TmuxPane } from "../terminal-launch/tmux.ts";
import { canonical } from "./repo.ts";

/** Who is asking or recording, and which database holds the openings (tests; the default is the shared agent database). */
export interface OpeningScope {
	env?: NodeJS.ProcessEnv | undefined;
	db?: AgentDb | undefined;
}

/** The agent that opened something and the session it ran in. */
export interface Opener {
	/** The agent id (the session's own id, or the parent of an isolated child). */
	id: string;
	sessionId?: string | undefined;
}

const dbOf = (scope: OpeningScope): AgentDb => scope.db ?? sharedAgentDb(scope.env);

/** The key of a tmux pane or window: tmux ids repeat across servers, so the server's socket is part of it. */
const tmuxRef = (env: NodeJS.ProcessEnv, id: string): string => `${(env.TMUX ?? "").split(",")[0]}|${id}`;

export function recordWorktreeOpening(folder: string, opener: Opener, scope: OpeningScope = {}): void {
	openings.record(dbOf(scope).db, "worktree", canonical(folder), opener.id, opener.sessionId, Date.now());
}

export function recordTmuxOpening(id: string, opener: Opener, scope: OpeningScope = {}): void {
	openings.record(
		dbOf(scope).db,
		"tmux",
		tmuxRef(scope.env ?? process.env, id),
		opener.id,
		opener.sessionId,
		Date.now(),
	);
}

/** Forgets a worktree that was removed, so a later one at the same folder starts without an opener. */
export function forgetWorktreeOpening(folder: string, scope: OpeningScope = {}): void {
	openings.forget(dbOf(scope).db, "worktree", canonical(folder));
}

/** The recorded openers of worktree `folders` (by folder as given); a folder opened before openers were recorded is absent. */
export function worktreeOpenings(folders: readonly string[], scope: OpeningScope = {}): Map<string, Opening> {
	const byCanonical = openings.lookup(dbOf(scope).db, "worktree", folders.map(canonical));
	return new Map(
		folders.flatMap((folder) => {
			const found = byCanonical.get(canonical(folder));
			return found ? [[folder, found] as const] : [];
		}),
	);
}

/** The openers of tmux `panes`, by pane id: a pane is found by its own id, or by its window's (`new-window` printed that). */
export function tmuxOpenings(panes: readonly TmuxPane[], scope: OpeningScope = {}): Map<string, Opening> {
	const env = scope.env ?? process.env;
	const ids = [...new Set(panes.flatMap((pane) => (pane.windowId ? [pane.id, pane.windowId] : [pane.id])))];
	const byRef = openings.lookup(
		dbOf(scope).db,
		"tmux",
		ids.map((id) => tmuxRef(env, id)),
	);
	return new Map(
		panes.flatMap((pane) => {
			const found = byRef.get(tmuxRef(env, pane.id)) ?? (pane.windowId && byRef.get(tmuxRef(env, pane.windowId)));
			return found ? [[pane.id, found] as const] : [];
		}),
	);
}

/** `yours` for what `self` opened, `opened by <agent>` for another's, nothing when nobody is recorded. */
export function openerLabel(opening: Opening | undefined, self: string | undefined): string | undefined {
	if (!opening) return undefined;
	return opening.opener === self ? "yours" : `opened by ${opening.opener}`;
}
