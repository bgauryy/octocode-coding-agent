import { renderPrompt } from "../../core/prompt-template.ts";
import fs from "node:fs";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { type ChildFiles, type SessionChild, sessionChildren } from "../child-sessions/session-children.ts";
import { type ChildSession, childSessionFile } from "./process/session.ts";
import { REF_PREFIX, repoRoot, worktreesDir } from "./worktree-base.ts";
import { gitSync } from "../../utils/git-run.ts";
import { GENERAL_PROFILE } from "./profiles.ts";
import { liveProcess } from "../shared/process.ts";
import type { AgentEnd } from "../team/panel/state.ts";

/** What a resume knows beyond the session's entries. */
export interface ResumeOptions {
	/**
	 * Children whose previous process still has a live team row: it noticed its parent is gone and is exiting (up to a
	 * second to notice, then its stop grace). Such a child is neither announced as ended nor resumed until it exits.
	 */
	stillExiting?: ReadonlySet<string>;
	/** Whether `ref` exists in this checkout: an isolated child resumes from its saved `refs/octocode/<id>`. */
	refExists?: (ref: string) => boolean;
	/** Where isolated child `id`'s worktree goes in this checkout (`createWorktree`); a resume recreates it there. */
	worktreePath?: (id: string) => string;
}

/** `ResumeOptions` for an isolated child of the checkout at `cwd`: its refs and worktree folder, read only when asked. */
export function isolatedCheckout(cwd: string): Pick<ResumeOptions, "refExists" | "worktreePath"> {
	return {
		refExists: (ref) => {
			const repo = repoRoot(cwd);
			try {
				gitSync(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeoutMs: 10_000 });
				return true;
			} catch {
				// `--verify --quiet` exits non-zero for a missing ref.
				return false;
			}
		},
		worktreePath: (id) => path.join(worktreesDir(repoRoot(cwd)), id),
	};
}

/** `resumableChild` for an `agent` call in `ctx`: not a child running now or still exiting, its worktree from this checkout. */
export function resumeChild(
	ctx: { cwd: string; sessionManager: { getEntries(): readonly unknown[] } },
	id: string,
	runs: { running: ReadonlyMap<string, unknown>; team: { members(): Member[]; id?: string | undefined } },
): ReturnType<typeof resumableChild> {
	return resumableChild(ctx.sessionManager.getEntries(), id, new Set(runs.running.keys()), {
		stillExiting: exitingChildren(runs.team.members(), runs.team.id),
		...isolatedCheckout(ctx.cwd),
	});
}

/**
 * The ids of `members` (live team rows) that are subagents still alive under `parent`: a resumed coordinator's children
 * that are still exiting. With `parent` unknown (the session has not joined the team yet) any live subagent row counts.
 */
export function exitingChildren(members: readonly Member[], parent: string | undefined): Set<string> {
	return new Set(
		members
			.filter(
				(member) =>
					member.role !== "main" &&
					(parent === undefined || member.parentId === parent) &&
					liveProcess(member.pid, member.started),
			)
			.map((member) => member.id),
	);
}

/** `, transcript ~/…` (or `, transcript folder ~/…` before the file is known) `, report ~/…`; empty when none is recorded. */
export function describeFiles(files: ChildFiles): string {
	const where = files.transcript
		? `, transcript ${homeTilde(files.transcript)}`
		: files.folder
			? `, transcript folder ${homeTilde(files.folder)}`
			: "";
	return `${where}${files.report ? `, report ${homeTilde(files.report)}` : ""}`;
}

/** The custom message that tells a fork's model about the children that stopped with the session it forked from. */
export const FORK_NOTE_TYPE = "octocode-agent-fork";

/**
 * For a fork: the children its copied entries started without a report. They stopped with the session it forked from
 * (a session switch stops background runs), whose next start receives their reports; this one can continue them.
 */
export function forkNote(entries: readonly unknown[]): string | undefined {
	const stopped = sessionChildren(entries).filter((child) => child.status === "background");
	if (stopped.length === 0) return undefined;
	return renderPrompt("notices/subagents/children-forked.md", { children: stopped.map(describeChild).join("; ") });
}

/**
 * For a resumed or restarted session: the children its entries started without a report, that do not run now and left no
 * report waiting. A killed parent writes no report, and its children notice and exit within a second, so without this
 * the transcript still says "its report arrives as a message" and the model plans around children that no longer exist.
 * A child named by an earlier note is not named again.
 */
export function resumeNote(
	entries: readonly unknown[],
	pending: ReadonlySet<string>,
	running: ReadonlySet<string>,
	options: ResumeOptions = {},
): string | undefined {
	const gone = endedChildren(entries, pending, running, options);
	return gone.length > 0 ? endedNote(gone) : undefined;
}

/**
 * At a resume or restart: the note on children that ended with the previous process (undefined when none did) and their
 * panel rows. A child whose live team row says it is still exiting (`exitingChildren`) is in neither.
 */
export function resumedChildren(
	entries: readonly unknown[],
	pending: ReadonlySet<string>,
	running: Pick<ReadonlySet<string>, "has">,
	team: { members(): Member[]; id?: string | undefined },
	now = Date.now(),
): { note: string | undefined; rows: ReturnType<typeof stoppedRows> } {
	const stillExiting = exitingChildren(team.members(), team.id);
	const gone = endedChildren(entries, pending, running, { stillExiting });
	return { note: gone.length > 0 ? endedNote(gone) : undefined, rows: stoppedRows(gone, team.id, now) };
}

/** The note naming children that ended with the previous process (`endedChildren`). */
const endedNote = (gone: readonly SessionChild[]): string =>
	renderPrompt("notices/subagents/children-ended.md", { children: gone.map(describeChild).join("; ") });

/** The children `resumeNote` names: started without a report, not running, not still exiting, no report waiting, not named before. */
function endedChildren(
	entries: readonly unknown[],
	pending: ReadonlySet<string>,
	running: Pick<ReadonlySet<string>, "has">,
	options: ResumeOptions = {},
): SessionChild[] {
	const told = entries.flatMap((entry) => {
		const note = entry as { type?: unknown; customType?: unknown; content?: unknown };
		return note.type === "custom_message" && note.customType === FORK_NOTE_TYPE && typeof note.content === "string"
			? [note.content]
			: [];
	});
	return sessionChildren(entries).filter(
		(child) =>
			child.status === "background" &&
			!running.has(child.id) &&
			!options.stillExiting?.has(child.id) &&
			!pending.has(child.id) &&
			!told.some((note) => note.includes(`${child.id} (`)),
	);
}

/** Panel rows for children that stopped with the previous process (`FinishedTracker.restore`). */
function stoppedRows(
	children: readonly SessionChild[],
	parentId: string | undefined,
	now: number,
): { member: Member; end: AgentEnd }[] {
	return children.map((child) => ({
		member: {
			id: child.id,
			role: child.profile,
			...(parentId ? { parentId } : {}),
			pid: 0,
			status: "idle",
			goal: child.goal,
			joinedAt: now,
			updatedAt: now,
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		},
		end: { outcome: "stopped", headline: "stopped with the session" },
	}));
}

/**
 * `isolated, worktree <id>` while the child runs; once it ended its worktree is removed and the result lives on
 * `refs/octocode/<id>`. The worktree folder is named by the agent id.
 */
function isolatedNote(child: SessionChild): string {
	return child.status === "background"
		? `isolated, worktree ${child.id}`
		: `isolated, worktree ${child.id} (gone), result on ${REF_PREFIX}${child.id}`;
}

/** `general-bg (general, goal "…", stopped, transcript ~/…, report ~/…)`. */
export function describeChild(child: SessionChild): string {
	const status = child.outcome && child.outcome !== child.status ? `${child.status}: ${child.outcome}` : child.status;
	return `${child.id} (${child.profile}, goal "${child.goal}", ${status}${describeFiles(child)}${child.isolated ? `, ${isolatedNote(child)}` : ""})`;
}

/**
 * The child `id` this session recorded, and the session its continuation reopens: the folder of its recorded transcript
 * and its id (Octocode reopens `<folder>/<timestamp>_<id>.jsonl` for `--session-dir <folder> --session-id <id>`). Throws the
 * refusal: an id the session never started (naming the ones it did), a child running now or whose previous process is
 * still exiting (`options.stillExiting`: two processes must never write one transcript), one that ran isolated whose
 * saved ref is gone or whose worktree path is taken, or one whose transcript is not saved. An isolated child returns
 * `worktree`: the ref and path its worktree is recreated from. A child that crashed while starting saved nothing:
 * `restart` is the task it was given, which it runs again in its recorded session folder.
 */
export function resumableChild(
	entries: readonly unknown[],
	id: string,
	running: ReadonlySet<string>,
	options: ResumeOptions = {},
): { child: SessionChild; session: ChildSession; restart?: string; worktree?: { ref: string; path: string } } {
	const children = sessionChildren(entries);
	const child = children.find((candidate) => candidate.id === id);
	if (!child)
		throw new Error(
			`No subagent "${id}" in this session. ${children.length > 0 ? `Its subagents: ${children.map(describeChild).join("; ")}.` : "It started none."}`,
		);
	if (running.has(id)) throw new Error(`${id} is running; send it a message with \`agent\` type \`message\` instead.`);
	if (options.stillExiting?.has(id))
		throw new Error(
			`${id} is still exiting from the previous session's run; resume it once it has left the team (\`agent\` type \`coordinate\` action \`list\`).`,
		);
	const worktree = child.isolated ? isolatedWorktree(id, options) : undefined;
	const more = worktree ? { worktree } : {};
	// A run that never reported recorded only its folder: Octocode named the file in it.
	const sessionId = child.sessionId ?? id;
	const transcript =
		child.transcript ?? (child.folder ? childSessionFile({ dir: child.folder, id: sessionId }) : undefined);
	const folder = child.folder ?? (transcript ? path.dirname(transcript) : undefined);
	if (child.startupFailed && child.task && folder && !(transcript && fs.existsSync(transcript)))
		return { child, session: { dir: folder, id: sessionId }, restart: child.task, ...more };
	if (!transcript) throw new Error(`${id} has no saved transcript to continue.`);
	if (!fs.existsSync(transcript))
		throw new Error(
			`${id}'s transcript ${homeTilde(transcript)} is gone; start a new agent with the context it needs.`,
		);
	return { child, session: { dir: path.dirname(transcript), id: sessionId }, ...more };
}

/** The saved ref and free recorded path an isolated child's worktree is recreated from; throws the refusal otherwise. */
function isolatedWorktree(id: string, options: ResumeOptions): { ref: string; path: string } {
	const ref = `${REF_PREFIX}${id}`;
	if (!options.worktreePath || !options.refExists?.(ref))
		throw new Error(
			`${id} ran in an isolated worktree, which is gone, and no saved ${ref} is here to recreate it from (merged or discarded); start a new agent with the context it needs.`,
		);
	const at = options.worktreePath(id);
	if (fs.existsSync(at) || fs.existsSync(`${at}.json`))
		throw new Error(
			`${id}'s worktree ${homeTilde(at)} already exists (kept when its changes could not be saved, or in use); save or remove it, then resume.`,
		);
	return { ref, path: at };
}

/**
 * The task a continued child runs: its recorded profile and browser mode, and its recorded model while that is still
 * among `available` (else the profile's or parent's routing applies), unless the call names its own. A call naming
 * another profile is refused: the saved conversation was built under the recorded profile's prompt, tools and approval.
 */
export function resumedTask<T extends { profile?: string; headless?: boolean; model?: string }>(
	params: T,
	child: SessionChild,
	available: readonly { provider: string; id: string }[],
): T {
	if (params.profile && params.profile !== child.profile)
		throw new Error(
			`${child.id} ran as ${child.profile}, and a resume keeps that profile. Omit profile to continue it, or start a new agent as ${params.profile}.`,
		);
	const recorded = child.model?.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
	const usable = recorded && available.some((model) => `${model.provider}/${model.id}` === recorded);
	return {
		...params,
		profile: child.profile !== GENERAL_PROFILE ? child.profile : undefined,
		headless: params.headless ?? child.headless,
		model: params.model ?? (usable ? child.model : undefined),
	};
}

/**
 * What a child is told, before its context is added: a new child its `task`; a resumed one a follow-up to its saved
 * conversation (`prefix`); one that crashed while starting (`restart`, nothing saved) the task it was first given, with
 * the new call's text after it when that differs.
 */
export function resumeText(resumed: { restart?: string } | undefined, task: string): { text: string; prefix: string } {
	if (!resumed) return { text: task, prefix: "" };
	const { restart } = resumed;
	const followUp = `${renderPrompt("notices/subagents/follow-up.md")}\n`;
	if (restart === undefined) return { text: task, prefix: followUp };
	const more = task.trim() && task.trim() !== restart.trim() ? `\n\n${followUp}${task}` : "";
	return { text: `${restart}${more}`, prefix: "" };
}
