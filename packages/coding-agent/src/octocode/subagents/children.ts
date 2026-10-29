import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../../utils/guards.ts";
import { tildePath } from "../shared/home.ts";
import { entryMessage } from "../shared/util.ts";
import { AGENT_RESULT_TYPE } from "../shared/messages.ts";
import { type ChildSession, childSessionFile } from "./process/session.ts";
import { GENERAL_PROFILE } from "./profiles.ts";

/**
 * The subagents a session started, read from its entries: each `agent` task result (`RunDetails`) and each background
 * report (`ResultDetails`, `AGENT_RESULT_TYPE`) names the child, its status and its saved conversation (`details.session`).
 * The session's own record is the authority: a child it does not name is not its child.
 */

/** Where a child's saved conversation and report are, from the `session` its details recorded. */
export interface ChildFiles {
	/** Its transcript file, once the run ended (`session.file`). */
	transcript?: string;
	/** Its session folder (`session.dir`), recorded when the run starts: the transcript is written there. */
	folder?: string;
	/** Its whole report (`report.md` in its scratch folder), when the report was long enough to be saved. */
	report?: string;
}

/** The files a run's `session` details point at; the report only when it exists. */
export function childFiles(session: unknown): ChildFiles {
	if (!isRecord(session)) return {};
	const transcript = typeof session.file === "string" ? session.file : undefined;
	const folder = typeof session.dir === "string" ? session.dir : transcript ? path.dirname(transcript) : undefined;
	// The session folder is `<scratch>/session`; the report is saved beside it.
	const report = folder ? path.join(path.dirname(folder), "report.md") : undefined;
	return {
		...(transcript ? { transcript } : {}),
		...(typeof session.dir === "string" ? { folder: session.dir } : {}),
		...(report && fs.existsSync(report) ? { report } : {}),
	};
}

/** `, transcript ~/…` (or `, transcript folder ~/…` before the file is known) `, report ~/…`; empty when none is recorded. */
export function describeFiles(files: ChildFiles): string {
	const where = files.transcript
		? `, transcript ${tildePath(files.transcript)}`
		: files.folder
			? `, transcript folder ${tildePath(files.folder)}`
			: "";
	return `${where}${files.report ? `, report ${tildePath(files.report)}` : ""}`;
}

/** One subagent this session started, as its latest record says. */
export interface SessionChild {
	id: string;
	profile: string;
	goal: string;
	/** `background` while its report has not arrived; else `done`, `failed` or `stopped`. */
	status: string;
	/** The outcome its report named (`done`, `partial`, `blocked`, `failed`). */
	outcome?: string;
	transcript?: string;
	/** Its session folder while its transcript file is not recorded (a background run whose report never arrived). */
	folder?: string;
	report?: string;
	/** It ran in a private worktree, removed when it ended. */
	isolated?: true;
	/** The browser mode the call chose. */
	headless?: boolean;
	/** The `provider/id` (with any `:thinking`) it ran on; absent when it ran on the parent's model. */
	model?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Every subagent the entries name, in the order they started, each with its latest status and files. */
export function sessionChildren(entries: readonly unknown[]): SessionChild[] {
	const inputs = new Map<string, Record<string, unknown>>();
	const children = new Map<string, SessionChild>();
	const runs = new Map<string, { id?: string; startedAt?: number }>();
	const retired = new Set<string>();
	const rememberRun = (id: string, details: Record<string, unknown>) => {
		const run = {
			id: text(details.runId),
			startedAt: typeof details.startedAt === "number" ? details.startedAt : undefined,
		};
		const previous = runs.get(id)?.id;
		if (previous && previous !== run.id) retired.add(previous);
		runs.set(id, run);
	};
	const update = (child: SessionChild, details: Record<string, unknown>) => {
		const status = text(details.status);
		if (status && status !== "waiting" && status !== "running") child.status = status;
		const outcome = text(details.outcome);
		if (outcome) child.outcome = outcome;
		const files = childFiles(details.session);
		if (files.transcript) {
			child.transcript = files.transcript;
			delete child.folder;
		} else if (files.folder && !child.transcript) child.folder = files.folder;
		if (files.report) child.report = files.report;
		const model = text(details.model);
		if (model) child.model = model;
	};
	for (const entry of entries) {
		const message = entryMessage(entry);
		if (!isRecord(message)) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content)
				if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && isRecord(part.arguments))
					inputs.set(part.id, isRecord(part.arguments.input) ? part.arguments.input : part.arguments);
			continue;
		}
		const details = isRecord(message.details) ? message.details : undefined;
		const id = text(details?.id);
		if (!details || !id) continue;
		if (message.role === "custom" && message.customType === AGENT_RESULT_TYPE) {
			const child = children.get(id);
			const runId = text(details.runId);
			const previous = runs.get(id);
			if (!runId && previous?.id) continue;
			if (runId && retired.has(runId)) continue;
			if (
				typeof details.startedAt === "number" &&
				previous?.startedAt !== undefined &&
				details.startedAt < previous.startedAt
			)
				continue;
			// A message can continue a lingering child without a new task result; its later report advances the history.
			if (child) {
				rememberRun(id, details);
				update(child, details);
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "agent") continue;
		if (details.agentType !== undefined && details.agentType !== "task") continue;
		const profile = text(details.profile);
		if (!profile) continue;
		const input = inputs.get(String(message.toolCallId)) ?? {};
		const child: SessionChild = children.get(id) ?? { id, profile, goal: text(details.goal) ?? "", status: "" };
		rememberRun(id, details);
		delete child.outcome;
		child.profile = profile;
		child.goal = text(details.goal) ?? child.goal;
		if (input.isolate === true) child.isolated = true;
		else delete child.isolated;
		if (typeof input.headless === "boolean") child.headless = input.headless;
		update(child, details);
		children.set(id, child);
	}
	return [...children.values()];
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
