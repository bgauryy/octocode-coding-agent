import fs from "node:fs";
import path from "node:path";
import { tildePath } from "../shared/home.ts";
import { type ChildFiles, type SessionChild, sessionChildren } from "../shared/session-children.ts";
import { type ChildSession, childSessionFile } from "./process/session.ts";
import { GENERAL_PROFILE } from "./profiles.ts";

/** `, transcript ~/…` (or `, transcript folder ~/…` before the file is known) `, report ~/…`; empty when none is recorded. */
export function describeFiles(files: ChildFiles): string {
	const where = files.transcript
		? `, transcript ${tildePath(files.transcript)}`
		: files.folder
			? `, transcript folder ${tildePath(files.folder)}`
			: "";
	return `${where}${files.report ? `, report ${tildePath(files.report)}` : ""}`;
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
	return `[Fork] These subagents were running when this session was forked; they stopped with the session it was forked from, which receives their reports: ${stopped.map(describeChild).join("; ")}. To continue one here, call \`agent\` type \`task\` with \`resume\` set to its id.`;
}

/** `general-bg (general, goal "…", stopped, transcript ~/…, report ~/…)`. */
export function describeChild(child: SessionChild): string {
	const status = child.outcome && child.outcome !== child.status ? `${child.status}: ${child.outcome}` : child.status;
	return `${child.id} (${child.profile}, goal "${child.goal}", ${status}${describeFiles(child)}${child.isolated ? ", isolated" : ""})`;
}

/**
 * The child `id` this session recorded, and the session its continuation reopens: the folder of its recorded transcript
 * and its id (Octocode reopens `<folder>/<timestamp>_<id>.jsonl` for `--session-dir <folder> --session-id <id>`). Throws the
 * refusal: an id the session never started (naming the ones it did), a child running now, one that ran isolated (its
 * worktree is gone), or one whose transcript is not saved.
 */
export function resumableChild(
	entries: readonly unknown[],
	id: string,
	running: ReadonlySet<string>,
): { child: SessionChild; session: ChildSession } {
	const children = sessionChildren(entries);
	const child = children.find((candidate) => candidate.id === id);
	if (!child)
		throw new Error(
			`No subagent "${id}" in this session. ${children.length > 0 ? `Its subagents: ${children.map(describeChild).join("; ")}.` : "It started none."}`,
		);
	if (running.has(id)) throw new Error(`${id} is running; send it a message with \`agent\` type \`message\` instead.`);
	if (child.isolated)
		throw new Error(`${id} ran in an isolated worktree, which is gone; start a new agent with the context it needs.`);
	// A run that never reported recorded only its folder: Octocode named the file in it.
	const transcript = child.transcript ?? (child.folder ? childSessionFile({ dir: child.folder, id }) : undefined);
	if (!transcript) throw new Error(`${id} has no saved transcript to continue.`);
	if (!fs.existsSync(transcript))
		throw new Error(
			`${id}'s transcript ${tildePath(transcript)} is gone; start a new agent with the context it needs.`,
		);
	return { child, session: { dir: path.dirname(transcript), id } };
}

/**
 * The task a continued child runs: its recorded profile and browser mode, and its recorded model while that is still
 * among `available` (else the profile's or parent's routing applies), unless the call names its own.
 */
export function resumedTask<T extends { profile?: string; headless?: boolean; model?: string }>(
	params: T,
	child: SessionChild,
	available: readonly { provider: string; id: string }[],
): T {
	const recorded = child.model?.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
	const usable = recorded && available.some((model) => `${model.provider}/${model.id}` === recorded);
	return {
		...params,
		profile: child.profile !== GENERAL_PROFILE ? child.profile : undefined,
		headless: params.headless ?? child.headless,
		model: params.model ?? (usable ? child.model : undefined),
	};
}
