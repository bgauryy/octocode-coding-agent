import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { hasTmuxSession } from "@octocodeai/octocode-tui";
import { type Subcommand, type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { gitQuiet } from "../shared/git.ts";
import { listTmuxPanes, type TmuxPane } from "../terminal-launch/tmux.ts";
import { worktreeTrustTitle } from "./approval.ts";
import { describeWorktree, ensureWorktree } from "./create.ts";
import { worktreeNames } from "./names.ts";
import {
	agentLabel,
	innermostWorktree,
	paneLabel,
	parkedLabel,
	placeOccupants,
	type ParkedResident,
} from "./occupants.ts";
import { type OpenDependencies, type OpenPlacement, openInTmux, parsePlacement } from "./open.ts";
import { removeWorktree } from "./remove.ts";
import { canonical } from "./repo.ts";
import { worktreeStatuses, type WorktreeStatus } from "./status.ts";
import { MAIN_CHECKOUT, switchToWorktree } from "./switch.ts";
import { existingWorktree } from "./target.ts";

const USAGE =
	"Usage: /worktree [list | new <name> | open <name> [pane [right|down]|window] | switch <name|main> | merge <branch> | remove <name> [--force]]";

/** The tmux launch dependencies (`open.ts`) plus the team's live agents. */
export interface WorktreeCommandDependencies extends OpenDependencies {
	/** Live agents of this repository's team, every worktree included; `list` shows each under its worktree. */
	members?: () => Member[];
	/** Follow-up windows that sessions hold open for finished children: `remove` keeps a worktree they work in. */
	parked?: () => ParkedResident[];
	/** The session's folder, for completing names: the process directory does not follow `switch` or `/resume`. */
	cwd?: () => string | undefined;
	/** Lands a linked worktree's branch in the main checkout: the user typed it, so nothing asks again. */
	merge?: (branch: string, ctx: ExtensionCommandContext) => Promise<{ ok: boolean; text: string }>;
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

/** The team's live agents and tmux panes, sorted into the worktree `roots` each works in. */
async function whoIsWhere(roots: readonly string[], deps: WorktreeCommandDependencies, askTmux = false) {
	const members = deps.members?.() ?? [];
	const env = deps.env ?? process.env;
	// `list` asks tmux only when this session or an agent runs in it, so a list outside tmux spawns nothing; `remove`
	// always asks, because a shell in that folder matters wherever Octocode runs.
	const panes: TmuxPane[] =
		askTmux || hasTmuxSession(env) || members.some((member) => member.tmuxPane)
			? await listTmuxPanes({ env, ...(deps.tmux?.runner ? { runner: deps.tmux.runner } : {}) })
			: [];
	return { members, panes, ...placeOccupants(roots, members, panes) };
}

/** `agents: …; tmux: …` for one worktree's occupants, in the words `list` uses; undefined when nobody is there. */
function occupantsText(
	agents: readonly Member[],
	tmuxPanes: readonly TmuxPane[],
	panes: readonly TmuxPane[],
	parked: readonly ParkedResident[] = [],
): string | undefined {
	const parts = [
		agents.length > 0 ? `agents: ${agents.map((member) => agentLabel(member, panes)).join("; ")}` : "",
		parked.length > 0 ? `reachable finished agents: ${parked.map(parkedLabel).join("; ")}` : "",
		tmuxPanes.length > 0 ? `tmux: ${tmuxPanes.map(paneLabel).join("; ")}` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

async function list(ctx: ExtensionCommandContext, deps: WorktreeCommandDependencies): Promise<void> {
	const { main, statuses } = await worktreeStatuses(ctx.cwd);
	const roots = statuses.filter((status) => !status.entry.prunable).map((status) => status.entry.path);
	const { members, panes, byRoot, unplaced } = await whoIsWhere(roots, deps);
	// Linked worktrees sit inside the main one, so the session's worktree is the innermost holding its directory.
	const current = innermostWorktree(roots, ctx.cwd);
	const lines = [`Worktrees of ${main}:`];
	for (const status of statuses) {
		lines.push(listLine(status, main, status.entry.path === current));
		const here = byRoot.get(status.entry.path);
		if (here?.agents.length)
			lines.push(`      agents: ${here.agents.map((member) => agentLabel(member, panes)).join("; ")}`);
		if (here?.panes.length) lines.push(`      tmux: ${here.panes.map(paneLabel).join("; ")}`);
	}
	if (unplaced.length > 0)
		lines.push(`  Agents in no listed worktree: ${unplaced.map((member) => agentLabel(member, panes)).join("; ")}`);
	if (!statuses.some((status) => status.name)) lines.push("  No worktrees yet: /worktree new <name> creates one.");
	if (statuses.some((status) => !status.main && !status.name))
		lines.push("  other: a linked worktree not made by /worktree");
	if (deps.members && members.length === 0)
		lines.push(
			"  No agents have joined this repository's team (a session joins when it reserves files, messages or starts a subagent).",
		);
	say(ctx, lines.join("\n"));
}

/** `openInTmux` with this process's tmux check. */
const launch = (
	name: string,
	folder: string,
	placement: OpenPlacement,
	ctx: ExtensionCommandContext,
	deps: WorktreeCommandDependencies,
) => openInTmux(name, folder, placement, ctx, { ...deps, inTmux: hasTmuxSession(deps.env ?? process.env) });

async function create(name: string, ctx: ExtensionCommandContext, deps: WorktreeCommandDependencies): Promise<void> {
	const info = await ensureWorktree(
		ctx.cwd,
		name,
		ctx.hasUI ? (request) => ctx.ui.confirm(worktreeTrustTitle(request), "") : undefined,
	);
	say(ctx, describeWorktree(info));
	const skipped = info.include.skipped.map((item) => `${item.path} (${item.reason})`);
	if (skipped.length > 0) say(ctx, `Not copied from .worktreeinclude: ${skipped.join(", ")}`, "warning");
	// check-ignore exits 1 for a path no rule ignores.
	if ((await gitQuiet(info.main, ["check-ignore", "-q", path.relative(info.main, info.path)])) === undefined)
		say(ctx, "The folder .octocode/worktrees/ is not ignored by git: add it to .gitignore.", "warning");

	await launch(name, info.path, { placement: "window" }, ctx, deps);
}

/** `/worktree open <name> [pane [right|down]|window]`: Octocode in an existing worktree, in a new tmux window or pane. */
async function open(rest: string[], ctx: ExtensionCommandContext, deps: WorktreeCommandDependencies): Promise<void> {
	const [name, ...where] = rest;
	const placement = parsePlacement(where);
	if (!name || !placement) return say(ctx, USAGE, "warning");
	const { folder } = await existingWorktree(ctx.cwd, name);
	await launch(name, folder, placement, ctx, deps);
}

async function remove(rest: string[], ctx: ExtensionCommandContext, deps: WorktreeCommandDependencies): Promise<void> {
	const force = rest.includes("--force");
	const names = rest.filter((word) => word !== "--force");
	if (names.length !== 1 || names[0]?.startsWith("-")) return say(ctx, USAGE, "warning");
	const result = await removeWorktree(ctx.cwd, names[0], {
		force,
		sessionCwd: ctx.cwd,
		occupants: async (target, roots) => {
			const { panes, byRoot } = await whoIsWhere(roots, deps, true);
			const here = byRoot.get(roots.find((root) => canonical(root) === canonical(target)) ?? target);
			const parked = (deps.parked?.() ?? []).filter((child) => {
				const root = innermostWorktree(roots, child.workspace);
				return root !== undefined && canonical(root) === canonical(target);
			});
			return occupantsText(here?.agents ?? [], here?.panes ?? [], panes, parked);
		},
	});
	say(ctx, result.message, result.removed ? "info" : "warning");
}

/** After `open <name> `: where the new Octocode goes. */
const PLACEMENTS: Array<[string, string]> = [
	["window", "window — a new tmux window (the default)"],
	["pane", "pane [right|down] — split this tmux pane"],
	["pane right", "pane right — split beside this pane"],
	["pane down", "pane down — split below this pane"],
];

/** `/worktree`: list, create, open, switch to and remove the repository's git worktrees. */
export function worktreeCommand(deps: WorktreeCommandDependencies = {}): Subcommand {
	return {
		description: "List, create, open, switch and remove worktrees",
		argumentHint:
			"[list | new <name> | open <name> [pane [right|down]|window] | switch <name|main> | remove <name> [--force]]",
		complete: (prefix) => {
			const placing = /^open\s+\S+\s+(.*)$/su.exec(prefix);
			if (placing) return wordCompletions(PLACEMENTS, placing[1]);
			const naming = /^(open|switch)\s+(\S*)$/su.exec(prefix);
			if (naming) {
				const cwd = deps.cwd?.();
				const names: Array<string | [string, string]> = cwd ? worktreeNames(cwd) : [];
				if (naming[1] === "switch")
					names.unshift([MAIN_CHECKOUT, "main — the main checkout, even if a worktree has this name"]);
				return wordCompletions(names, naming[2]);
			}
			return wordCompletions(
				[
					["list", "list — worktrees with branch, changes, unmerged commits, live agents and tmux panes"],
					["new", "new <name> — create one and open Octocode in it"],
					["open", "open <name> [pane [right|down]|window] — open Octocode in an existing worktree in tmux"],
					[
						"switch",
						"switch <name|main> — move this session into a worktree or back to main (the old one stays saved)",
					],
					["merge", "merge <branch> — in the main checkout, land a linked worktree's branch"],
					[
						"remove",
						"remove <name> [--force] — remove one that holds no unsaved work, live agents, reachable finished agents or tmux panes",
					],
				],
				prefix,
			);
		},
		handler: async (args, ctx) => {
			const [action = "list", ...rest] = args.split(/\s+/u).filter(Boolean);
			try {
				if (action === "list" && rest.length === 0) return await list(ctx, deps);
				if (action === "new" && rest.length === 1) return await create(rest[0], ctx, deps);
				if (action === "open") return await open(rest, ctx, deps);
				if (action === "switch" && rest.length === 1) return await switchToWorktree(rest[0], ctx);
				if (action === "remove") return await remove(rest, ctx, deps);
				if (action === "merge" && rest.length === 1 && deps.merge) {
					const { ok, text } = await deps.merge(rest[0], ctx);
					return say(ctx, text, ok ? "info" : "warning");
				}
				say(ctx, USAGE, "warning");
			} catch (error) {
				say(ctx, errorMessage(error), "error");
			}
		},
	};
}

export function registerWorktreeCommand(commands: Subcommands, deps?: WorktreeCommandDependencies): void {
	commands.add("worktree", worktreeCommand(deps));
}
