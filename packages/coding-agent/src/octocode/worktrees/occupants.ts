import type { Member } from "@octocodeai/octocode-contracts/team";
import type { TmuxPane } from "../terminal-launch/tmux.ts";
import { tmuxMark } from "../shared/tmux-mark.ts";
import { canonical } from "./repo.ts";
import { insideWorktree } from "./status.ts";

/** What runs in one worktree: live agents of the team, and tmux panes open there that no agent names. */
export interface WorktreeOccupants {
	agents: Member[];
	panes: TmuxPane[];
}

/** `alpha-one (main, idle, pid 4242, tmux work:2.0)`: who it is, whether it is busy, its process and where to look. */
export function agentLabel(member: Member, panes: readonly TmuxPane[]): string {
	const parts = [member.parentId ? `${member.role} under ${member.parentId}` : member.role, member.status];
	parts.push(`pid ${member.pid}`);
	if (member.tmuxPane) parts.push(tmuxMark(member.tmuxPane, panes));
	return `${member.id} (${parts.join(", ")})`;
}

/** A finished child some session keeps reachable for follow-ups (a parked or lingering run); it works in `workspace`. */
export interface ParkedResident {
	id: string;
	role: string;
	/** The session that holds its window; `/resume` it to reach the child. */
	session: string;
	workspace: string;
}

/** `calm-prawn (implementer, session 01a1…)`. */
export const parkedLabel = (child: ParkedResident): string => `${child.id} (${child.role}, session ${child.session})`;

/** `work:3.0 (zsh, pid 5120)`. */
export const paneLabel = (pane: TmuxPane): string => `${pane.label} (${pane.command || "unknown"}, pid ${pane.pid})`;

/** The innermost of `roots` holding `dir`: linked worktrees live inside the main one, so the deepest match wins. */
export function innermostWorktree(roots: readonly string[], dir: string): string | undefined {
	return roots.filter((root) => insideWorktree(dir, root)).sort((a, b) => canonical(b).length - canonical(a).length)[0];
}

/**
 * Sorts live agents and tmux panes into the worktree each works in, keyed by the root as given. An agent belongs where
 * its `checkout` is (an isolated subagent reports its parent's checkout); a pane belongs to the innermost worktree holding
 * its current directory, unless an agent already names it. `unplaced`: agents in none of `roots`, such as rows of an
 * older build that recorded no checkout.
 */
export function placeOccupants(
	roots: readonly string[],
	members: readonly Member[],
	panes: readonly TmuxPane[],
): { byRoot: Map<string, WorktreeOccupants>; unplaced: Member[] } {
	const byRoot = new Map(roots.map((root): [string, WorktreeOccupants] => [root, { agents: [], panes: [] }]));
	const unplaced: Member[] = [];
	for (const member of members) {
		const root = member.checkout ? roots.find((candidate) => canonical(candidate) === member.checkout) : undefined;
		if (root) byRoot.get(root)?.agents.push(member);
		else unplaced.push(member);
	}
	const named = new Set(members.flatMap((member) => (member.tmuxPane ? [member.tmuxPane] : [])));
	for (const pane of panes) {
		const root = named.has(pane.id) ? undefined : innermostWorktree(roots, pane.cwd);
		if (root) byRoot.get(root)?.panes.push(pane);
	}
	return { byRoot, unplaced };
}
