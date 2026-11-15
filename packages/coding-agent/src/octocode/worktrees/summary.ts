import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { gitQuiet } from "../../utils/git-run.ts";
import { listTmuxPanes, type TmuxPane } from "../terminal-launch/tmux.ts";
import { agentLabel, innermostWorktree, paneLabel, placeOccupants } from "./occupants.ts";
import type { OpenDependencies } from "./open.ts";
import { worktreeStatuses, type WorktreeStatus } from "./status.ts";

/** What the worktree summary reads besides git: the team's live agents and how tmux is reached. */
export interface SummaryDependencies extends Pick<OpenDependencies, "env" | "tmux"> {
	/** Live agents of this repository's team, every worktree included. */
	members?: () => Member[];
}

/** Line breaks in a path or git message, shown as `\n` and `\r` so each worktree stays on its own line. */
const oneLine = (text: string): string => text.replace(/\r|\n/gu, (brk) => (brk === "\r" ? "\\r" : "\\n"));

/** `name · branch · state · path` for one worktree. */
function listLine(status: WorktreeStatus, main: string, current: boolean): string {
	const { entry } = status;
	const state = entry.prunable
		? ["folder missing (git worktree prune)"]
		: status.error
			? [`unreadable: ${oneLine(status.error)}`]
			: [
					status.dirty > 0 ? `${status.dirty} changed` : "",
					status.untracked > 0 ? `${status.untracked} untracked` : "",
					status.unmerged > 0
						? `${status.unmerged} commit${status.unmerged === 1 ? "" : "s"} not on another branch`
						: "",
				].filter(Boolean);
	const label = status.main ? "main" : (status.name ?? "other");
	const branch = entry.branch ? `branch ${entry.branch}` : "detached";
	const where = path.relative(main, entry.path) || ".";
	const here = current ? " · current" : "";
	return `  ${label} · ${branch} · ${state.length > 0 ? state.join(", ") : "clean"} · ${oneLine(where.startsWith("..") ? entry.path : where)}${here}`;
}

/** Whether this session or an agent runs in tmux, the only case a listing asks tmux. */
function inTmux(deps: SummaryDependencies): boolean {
	return Boolean((deps.env ?? process.env).TMUX) || (deps.members?.() ?? []).some((member) => member.tmuxPane);
}

/** The team's live agents and tmux panes, sorted into the worktree `roots` each works in. */
export async function whoIsWhere(roots: readonly string[], deps: SummaryDependencies, askTmux = false) {
	const members = deps.members?.() ?? [];
	const env = deps.env ?? process.env;
	// A listing asks tmux only when this session or an agent runs in it, so one outside tmux spawns nothing; `remove`
	// always asks, because a shell in that folder matters wherever Octocode runs.
	const panes: TmuxPane[] =
		askTmux || inTmux(deps)
			? await listTmuxPanes({ env, ...(deps.tmux?.runner ? { runner: deps.tmux.runner } : {}) })
			: [];
	return { members, panes, ...placeOccupants(roots, members, panes) };
}

/** The lines of `/worktree list` (after its header) and of `coordinate list`: each worktree, then its agents and panes. */
export async function worktreeLines(cwd: string, deps: SummaryDependencies) {
	const { main, statuses } = await worktreeStatuses(cwd);
	const roots = statuses.filter((status) => !status.entry.prunable).map((status) => status.entry.path);
	const { members, panes, byRoot, unplaced } = await whoIsWhere(roots, deps);
	// Linked worktrees sit inside the main one, so the session's worktree is the innermost holding its directory.
	const current = innermostWorktree(roots, cwd);
	const lines: string[] = [];
	const occupied = new Set<string>();
	for (const status of statuses) {
		lines.push(listLine(status, main, status.entry.path === current));
		const here = byRoot.get(status.entry.path);
		if (here && (here.agents.length > 0 || here.panes.length > 0)) occupied.add(status.entry.path);
		if (here?.agents.length)
			lines.push(`      agents: ${here.agents.map((member) => agentLabel(member, panes)).join("; ")}`);
		if (here?.panes.length) lines.push(`      tmux: ${here.panes.map(paneLabel).join("; ")}`);
	}
	if (unplaced.length > 0)
		lines.push(`  Agents in no listed worktree: ${unplaced.map((member) => agentLabel(member, panes)).join("; ")}`);
	return { main, statuses, members, lines, occupied };
}

/**
 * The `Worktrees:` block of `coordinate list`, or undefined when the repository has only its main worktree and nothing
 * runs in tmux. A clean worktree nobody works in is named as ready to close with `/worktree remove`.
 */
export async function describeWorktrees(cwd: string, deps: SummaryDependencies): Promise<string | undefined> {
	// Outside a git checkout (or in a bare repository) there are no worktrees to show.
	if (!(await gitQuiet(cwd, ["rev-parse", "--show-toplevel"]))) return undefined;
	const { statuses, lines, occupied } = await worktreeLines(cwd, deps);
	if (!statuses.some((status) => !status.main) && !inTmux(deps)) return undefined;
	const idle = statuses
		.filter((status) => !status.main && status.name && !status.error && !status.entry.prunable)
		.filter((status) => status.dirty + status.untracked + status.unmerged === 0)
		.filter((status) => !occupied.has(status.entry.path))
		.map((status) => status.name);
	const close = idle.length > 0 ? [`  clean, no agents: close with /worktree remove <name>: ${idle.join(", ")}`] : [];
	return ["Worktrees:", ...lines, ...close].join("\n");
}
