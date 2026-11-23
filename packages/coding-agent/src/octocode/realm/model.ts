import fs from "node:fs";
import path from "node:path";
import type { ActivityTone } from "@octocodeai/octocode-contracts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { memberWorktree } from "../worktree-paths/member-worktree.ts";
import { innermostWorktree } from "../worktrees/occupants.ts";
import { canonical } from "../worktrees/repo.ts";

/**
 * A realm is one place work happens in a repository: the main checkout, a worktree made by `/worktree new`, an isolated
 * agent's private worktree, or any other linked worktree.
 */
export type RealmKind = "checkout" | "worktree" | "isolated" | "linked";

/** A folder git lists (or an agent works in), before agents and sessions are sorted into it. */
export interface RealmFolder {
	path: string;
	kind: RealmKind;
	/** Short branch name; undefined when detached. */
	branch?: string;
	/** Changed plus untracked files; undefined when the folder is gone or git could not read it. */
	changed?: number;
	/** Commits on no other branch. */
	unmerged?: number;
	/** Why git could not read the folder. */
	error?: string;
	/** The folder no longer exists. */
	gone: boolean;
}

/** A saved session of this repository, as the realm view needs it. */
export interface RealmSession {
	id: string;
	name?: string;
	cwd: string;
	/** Last activity, epoch ms. */
	modified: number;
	/** Its process is running now. */
	live: boolean;
	/** What that process last said it is doing (its light's tone); only for a live session other than this one. */
	activity?: ActivityTone;
	current: boolean;
	file: string;
}

export interface Realm {
	/** What `/realm <name>` takes: `main` for the checkout, the worktree's name, an isolated agent's id, else the folder name. */
	name: string;
	folder: RealmFolder;
	/** This session works here. */
	current: boolean;
	agents: Member[];
	sessions: RealmSession[];
	/** Epoch ms of the latest agent update or session activity; undefined when nothing ran here. */
	lastActive?: number;
}

export interface RealmView {
	/** The main checkout's root. */
	main: string;
	realms: Realm[];
	/** Agents in no listed realm, such as rows of an older build that recorded no folder. */
	otherAgents: Member[];
	/** Live sessions whose folder is in no listed realm. */
	otherSessions: RealmSession[];
}

/**
 * Sorts agents into the realm they work in. An agent belongs where its folder is: the innermost listed root holding its
 * `cwd`, else the root its recorded checkout names. An agent working in a folder git does not list (an isolated child
 * whose worktree was already pruned, a worktree git forgot) gets that folder as an extra root, found with
 * `memberWorktree`, so it still shows, `(gone)` when the folder is missing. `unplaced`: agents with no usable folder.
 */
function placeMembers(
	roots: readonly string[],
	main: string,
	members: readonly Member[],
): { byRoot: Map<string, Member[]>; extraRoots: string[]; unplaced: Member[] } {
	const byRoot = new Map(roots.map((root): [string, Member[]] => [root, []]));
	const extraRoots: string[] = [];
	const unplaced: Member[] = [];
	for (const member of members) {
		const listed =
			(member.cwd ? innermostWorktree(roots, member.cwd) : undefined) ??
			(member.checkout ? roots.find((root) => canonical(root) === canonical(member.checkout!)) : undefined);
		if (listed) {
			byRoot.get(listed)?.push(member);
			continue;
		}
		const elsewhere = member.cwd || member.checkout ? memberWorktree(member, main) : undefined;
		if (!elsewhere) {
			unplaced.push(member);
			continue;
		}
		const known = extraRoots.find((root) => canonical(root) === canonical(elsewhere));
		if (known) byRoot.get(known)?.push(member);
		else {
			extraRoots.push(elsewhere);
			byRoot.set(elsewhere, [member]);
		}
	}
	return { byRoot, extraRoots, unplaced };
}

const RANK: Record<RealmKind, number> = { checkout: 0, worktree: 1, isolated: 2, linked: 3 };

/** The `/realm` name of a folder: unique, so a second `lint` becomes `lint-2`. */
function nameOf(folder: RealmFolder, taken: Set<string>): string {
	const base = folder.kind === "checkout" ? "main" : path.basename(folder.path) || folder.path;
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	taken.add(name);
	return name;
}

export interface RealmInput {
	main: string;
	/** The folders git lists, the main checkout first. */
	folders: readonly RealmFolder[];
	members: readonly Member[];
	sessions: readonly RealmSession[];
	/** The folder of this session. */
	here: string;
}

/** Builds the realms: the checkout, then `/worktree new` worktrees, isolated agents' and other linked ones. */
export function buildRealms(input: RealmInput): RealmView {
	const { main, members, sessions, here } = input;
	const listed = input.folders.filter((folder) => !folder.gone).map((folder) => folder.path);
	const placing = placeMembers(
		input.folders.map((folder) => folder.path),
		main,
		members,
	);
	// A gone folder is not a place a session can be in, but its agents (if any) still belong to its row.
	const folders: RealmFolder[] = [
		...input.folders,
		...placing.extraRoots.map((folder): RealmFolder => ({
			path: folder,
			kind: "linked",
			gone: !fs.existsSync(folder),
		})),
	];
	const current = innermostWorktree(listed, here);
	const otherSessions: RealmSession[] = [];
	const sessionsOf = new Map<string, RealmSession[]>();
	for (const session of sessions) {
		const root = session.cwd ? innermostWorktree(listed, session.cwd) : undefined;
		if (root) sessionsOf.set(root, [...(sessionsOf.get(root) ?? []), session]);
		else if (session.live) otherSessions.push(session);
	}
	const taken = new Set<string>();
	const realms = folders
		.map((folder, index): { realm: Realm; index: number } => {
			const agents = placing.byRoot.get(folder.path) ?? [];
			const own = (sessionsOf.get(folder.path) ?? []).sort((a, b) => b.modified - a.modified);
			const times = [...agents.map((agent) => agent.updatedAt), ...own.map((session) => session.modified)];
			return {
				realm: {
					name: "",
					folder,
					current: current !== undefined && canonical(current) === canonical(folder.path),
					agents,
					sessions: own,
					...(times.length > 0 ? { lastActive: Math.max(...times) } : {}),
				},
				index,
			};
		})
		.sort((a, b) => RANK[a.realm.folder.kind] - RANK[b.realm.folder.kind] || a.index - b.index)
		.map(({ realm }) => ({ ...realm, name: nameOf(realm.folder, taken) }));
	return { main, realms, otherAgents: placing.unplaced, otherSessions };
}

/** The realm `query` names: its exact name, else the one realm whose name starts with it; undefined when none or several do. */
export function findRealm(view: RealmView, query: string): Realm | undefined {
	const wanted = query.trim().toLowerCase();
	if (!wanted) return undefined;
	const exact = view.realms.find((realm) => realm.name.toLowerCase() === wanted);
	if (exact) return exact;
	const starts = view.realms.filter((realm) => realm.name.toLowerCase().startsWith(wanted));
	return starts.length === 1 ? starts[0] : undefined;
}
