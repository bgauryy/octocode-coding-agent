import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { gitQuiet } from "../../utils/git-run.ts";
import { listTmuxPanes, type TmuxPane } from "../terminal-launch/tmux.ts";
import { type ForeignCli, foreignClis } from "./foreign-clis.ts";
import { agentLabel, innermostWorktree, paneLabel, placeOccupants } from "./occupants.ts";
import type { OpenDependencies } from "./open.ts";
import { openerLabel, tmuxOpenings, worktreeOpenings } from "./openings.ts";
import { worktreeStatuses, type WorktreeStatus } from "./status.ts";

/** What the worktree summary reads besides git: the team's live agents and how tmux is reached. */
export interface SummaryDependencies extends Pick<OpenDependencies, "env" | "tmux"> {
	/** Live agents of this repository's team, every worktree included. */
	members?: () => Member[];
	/** The asking session's agent id: what it opened is `yours`, and only that is named as safe to close. */
	self?: string | undefined;
	/** The database that keeps openers (tests; the default is the shared agent database). */
	openings?: OpenDependencies["openings"];
	/** Other vendors' agent CLIs on this machine (tests; the default reads the process table). */
	foreign?: (ownRoots: readonly number[]) => Promise<ForeignCli[]>;
}

/** `Claude Code pid 123; Codex pid 456`. */
const foreignText = (clis: readonly ForeignCli[]): string => clis.map((cli) => `${cli.name} pid ${cli.pid}`).join("; ");

/** Line breaks in a path or git message, shown as `\n` and `\r` so each worktree stays on its own line. */
const oneLine = (text: string): string => text.replace(/\r|\n/gu, (brk) => (brk === "\r" ? "\\r" : "\\n"));

/** `name · branch · state · path` for one worktree. */
function listLine(status: WorktreeStatus, main: string, current: boolean, opener?: string): string {
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
	const by = opener ? ` · ${opener}` : "";
	return `  ${label} · ${branch} · ${state.length > 0 ? state.join(", ") : "clean"} · ${oneLine(where.startsWith("..") ? entry.path : where)}${here}${by}`;
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
	const ownRoots = [process.pid, ...members.map((member) => member.pid)];
	const foreign = await (deps.foreign ?? ((own) => foreignClis({ ownRoots: own })))(ownRoots);
	const foreignAt = (root: string) => foreign.filter((cli) => innermostWorktree(roots, cli.cwd) === root);
	// Linked worktrees sit inside the main one, so the session's worktree is the innermost holding its directory.
	const current = innermostWorktree(roots, cwd);
	const scope = { env: deps.env, db: deps.openings };
	const opened = worktreeOpenings(
		statuses.filter((status) => !status.main).map((status) => status.entry.path),
		scope,
	);
	const paneOpened = tmuxOpenings(panes, scope);
	const paneText = (pane: TmuxPane): string => {
		const by = openerLabel(paneOpened.get(pane.id), deps.self);
		return by ? `${paneLabel(pane)} · ${by}` : paneLabel(pane);
	};
	const lines: string[] = [];
	const occupied = new Set<string>();
	for (const status of statuses) {
		lines.push(
			listLine(status, main, status.entry.path === current, openerLabel(opened.get(status.entry.path), deps.self)),
		);
		const here = byRoot.get(status.entry.path);
		if (here && (here.agents.length > 0 || here.panes.length > 0)) occupied.add(status.entry.path);
		if (here?.agents.length)
			lines.push(`      agents: ${here.agents.map((member) => agentLabel(member, panes)).join("; ")}`);
		if (here?.panes.length) lines.push(`      tmux: ${here.panes.map(paneText).join("; ")}`);
		const clis = foreignAt(status.entry.path);
		if (clis.length > 0) {
			occupied.add(status.entry.path);
			lines.push(`      other agent CLIs: ${foreignText(clis)}`);
		}
	}
	if (unplaced.length > 0)
		lines.push(`  Agents in no listed worktree: ${unplaced.map((member) => agentLabel(member, panes)).join("; ")}`);
	return {
		main,
		statuses,
		members,
		lines,
		occupied,
		opened,
		foreign: foreign.some((cli) => innermostWorktree(roots, cli.cwd) !== undefined),
	};
}

/**
 * The `Worktrees:` block of `coordinate list`, or undefined when the repository has only its main worktree and nothing
 * runs in tmux. A clean worktree nobody works in is named as ready to close only when the asking session opened it with `/worktree remove`.
 */
export async function describeWorktrees(cwd: string, deps: SummaryDependencies): Promise<string | undefined> {
	// Outside a git checkout (or in a bare repository) there are no worktrees to show.
	if (!(await gitQuiet(cwd, ["rev-parse", "--show-toplevel"]))) return undefined;
	const { statuses, lines, occupied, opened, foreign } = await worktreeLines(cwd, deps);
	if (!statuses.some((status) => !status.main) && !inTmux(deps) && !foreign) return undefined;
	const idle = statuses
		.filter((status) => !status.main && status.name && !status.error && !status.entry.prunable)
		.filter((status) => status.dirty + status.untracked + status.unmerged === 0)
		.filter((status) => !occupied.has(status.entry.path))
		.filter((status) => deps.self !== undefined && opened.get(status.entry.path)?.opener === deps.self)
		.map((status) => status.name);
	const reach = foreign
		? [
				"  Other agent CLIs get no `message`: avoid their files, read their work with the resume-external-harness skill, or ask the user to relay.",
			]
		: [];
	const close =
		idle.length > 0 ? [`  yours, clean, no agents: close with /worktree remove <name>: ${idle.join(", ")}`] : [];
	return ["Worktrees:", ...lines, ...reach, ...close].join("\n");
}
