import { renderPrompt } from "../../core/prompt-template.ts";
import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import { type AgentDb, backlog } from "../../../../db/src/api.ts";
import { BacklogStore } from "../backlog/store.ts";
import { taskLine } from "../backlog/task-format.ts";
import { contentText, HOUR_MS, MINUTE_MS } from "../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { flatLine, type SessionExtra, shownLine } from "./store.ts";

/** The tag that starts the resume brief, like `[After compaction]` on the notes after a compaction. */
export const RESUME_TAG = "[Resumed]";

/** Away longer than this is worth a brief by itself. */
const LONG_AWAY_MS = HOUR_MS;

/** `90_000` → `1m`, `7_200_000` → `2h`, three days → `3d`. */
export function shortDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
	if (minutes < 1) return "moments";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** The repository now, read when the brief is delivered. */
interface GitNow {
	branch?: string;
	head?: string;
	/** Changed or untracked paths in the working tree. */
	dirty: number;
	/** Commits from the recorded HEAD to the current one, when git can tell. */
	commitsSince?: number;
}

export interface BriefInput {
	/** What the session recorded before this start. */
	previous: Pick<SessionExtra, "branch" | "head">;
	/** When the session was last active (its last entry), in ms. */
	lastActive: number;
	sessionId: string;
	repoKey: string;
	git: GitNow;
	/** Background work that ended with the earlier process without reporting (see work.ts), already described. */
	unreported?: string[];
	/** Tool calls the earlier process made and recorded no result for (`unansweredCalls`), already described. */
	unanswered?: string[];
	/** The subagents an unanswered `agent` call started, with how each ended (`danglingChildren`). */
	children?: string[];
	/** The last user request of the saved session (`latestRequest`). */
	request?: string;
	/** A new user prompt started this run: the brief follows it in the conversation, so it says which request is current. */
	newPrompt?: boolean;
	now?: number;
}

/** Ongoing items the brief lists, one line each; the rest are named by number only. */
const MAX_ITEMS = 8;
/** More numbers than this are counted. */
const MAX_NAMED = 10;
/** Open tasks the brief lists, and the characters each may take. */
const MAX_TASKS = 8;
const TASK_CHARS = 160;
/** Characters kept of a described item's title and goal and of a step's reason (a cut ends in `…`). */
const FIELD_CHARS = { title: 100, goal: 120, why: 160 } as const;

/**
 * This session's ongoing backlog items, most important first, for the reorient brief: a header, then one line per
 * item (ref, title, goal) for the first `MAX_ITEMS` and the numbers of the rest. `backlog get` shows everything else.
 * Empty when the session holds none.
 */
export function ongoingBrief(agent: AgentDb, repoKey: string, sessionId: string): string[] {
	const rows = backlog.ongoingItems(agent.db, repoKey, sessionId);
	if (rows.length === 0) return [];
	const lines = [renderPrompt("notices/resume/ongoing-items.md")];
	for (const row of rows.slice(0, MAX_ITEMS)) {
		const goal = flatLine(row.goal) ? ` — goal: ${shownLine(row.goal, FIELD_CHARS.goal)}` : "";
		lines.push(`- B${row.seq} ${shownLine(row.title, FIELD_CHARS.title)}${goal}`);
	}
	const rest = rows.slice(MAX_ITEMS).map((row) => `B${row.seq}`);
	if (rest.length > 0)
		lines.push(`- ${rest.length} more: ${rest.slice(0, MAX_NAMED).join(", ")}${rest.length > MAX_NAMED ? ", …" : ""}`);
	return lines;
}

/** `2 under B12, 1 under B13, 1 of the session`: the open steps per owner, items first in the order given. */
function stepCounts(open: readonly BacklogTask[]): string {
	const counts = new Map<string, number>();
	for (const task of open) {
		const owner = task.owner.kind === "item" ? `under ${task.owner.ref}` : "of the session";
		counts.set(owner, (counts.get(owner) ?? 0) + 1);
	}
	const session = counts.get("of the session");
	counts.delete("of the session");
	if (session) counts.set("of the session", session);
	return [...counts].map(([owner, count]) => `${count} ${owner}`).join(", ");
}

/**
 * The open steps (tasks, `T<n>`) this session tracks, its own and those under the items it holds, for the reorient
 * brief: a header with the count per item, then up to `MAX_TASKS` one-line steps and the count
 * of the rest. Empty when there are none.
 */
export function openTasksBrief(agent: AgentDb, repoKey: string, sessionId: string): string[] {
	const { tasks } = new BacklogStore(() => agent, repoKey);
	const states = ["todo", "ongoing"] as const;
	const open = [
		...tasks.list({ session: sessionId, states }),
		...backlog.ongoingItems(agent.db, repoKey, sessionId).flatMap((row) => tasks.list({ item: `B${row.seq}`, states })),
	];
	if (open.length === 0) return [];
	return [
		renderPrompt("notices/resume/open-steps.md", { counts: stepCounts(open) }),
		...open
			.slice(0, MAX_TASKS)
			.flatMap((task) => [
				`- ${shownLine(taskLine(task), TASK_CHARS)}`,
				...(task.reason.trim() ? [`  why: ${shownLine(task.reason, FIELD_CHARS.why)}`] : []),
			]),
		...(open.length > MAX_TASKS ? [`- ${open.length - MAX_TASKS} more`] : []),
	];
}

/** What this agent holds in its team, read when the note is built: its path reservations and the questions it has read and not answered. */
export interface TeamNotes {
	/** Paths this agent has reserved (a tree ends with `/`). */
	reservations(): string[];
	questions(): Array<{ id: number; from: string; text: string }>;
}

/** Reserved paths and questions named in the note, and the characters each question may take. */
const MAX_RESERVED = 10;
const MAX_QUESTIONS = 5;
const QUESTION_CHARS = 160;

/**
 * The team state a summary may have dropped: the paths this agent reserved and has to unlock, and the `replyRequired`
 * questions it read and has not answered. Empty when it holds none or the team cannot be read.
 */
export function teamBrief(notes: TeamNotes): string[] {
	let reserved: string[] = [];
	let questions: ReturnType<TeamNotes["questions"]> = [];
	try {
		reserved = notes.reservations();
		questions = notes.questions();
	} catch {
		// The team database is unavailable: the rest of the note alone still helps.
	}
	return [
		...(reserved.length > 0
			? [
					renderPrompt("notices/resume/reserved-paths.md", {
						paths: reserved.slice(0, MAX_RESERVED).join(", "),
						more: Math.max(0, reserved.length - MAX_RESERVED),
					}),
				]
			: []),
		...(questions.length > 0
			? [
					renderPrompt("notices/resume/waiting-questions.md"),
					...questions
						.slice(0, MAX_QUESTIONS)
						.map(
							(question) =>
								`- #${question.id} from ${shownLine(question.from, 64)}: ${shownLine(question.text, QUESTION_CHARS)}`,
						),
					...(questions.length > MAX_QUESTIONS ? [`- ${questions.length - MAX_QUESTIONS} more`] : []),
				]
			: []),
	];
}

/** The index of the last user message in `entries` with text, or -1 when there is none. */
export function latestRequestIndex(entries: readonly unknown[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "user") continue;
		if (flatLine(contentText(entry.message.content))) return index;
	}
	return -1;
}

/** The last user message in `entries` with text, whole, or undefined when there is none. */
export function latestRequest(entries: readonly unknown[]): string | undefined {
	const entry = entries[latestRequestIndex(entries)] as { message: { content: unknown } } | undefined;
	return entry ? contentText(entry.message.content).trim() : undefined;
}

/**
 * What changed while the user was away from a resumed session, for the model and the user. Undefined unless there is
 * substance: the branch or HEAD moved, background work ended unreported, a tool call has no recorded result, this session has ongoing backlog items or open tasks, or
 * the user was away over an hour. The last request before the break, the to-do count and uncommitted changes are added
 * as context then, but never cause a brief alone (they rarely change between resumes). The first line carries the away
 * time and the most important change, so a collapsed view shows both.
 */
export function resumeBrief(agent: AgentDb, input: BriefInput): string | undefined {
	const now = input.now ?? Date.now();
	const { previous, git } = input;
	const facts: string[] = [];
	if (previous.branch && git.branch && previous.branch !== git.branch)
		facts.push(renderPrompt("notices/resume/branch-changed.md", { from: previous.branch, to: git.branch }));
	if (previous.head && git.head && previous.head !== git.head) {
		const count = git.commitsSince;
		facts.push(
			renderPrompt("notices/resume/head-moved.md", {
				from: previous.head.slice(0, 7),
				to: git.head.slice(0, 7),
				commits: count && count > 0 ? count : 0,
				several: count !== 1,
			}),
		);
	}
	if (input.unreported?.length)
		facts.unshift(renderPrompt("notices/resume/unreported.md", { work: input.unreported.join("; ") }));
	if (input.unanswered?.length)
		facts.unshift(
			renderPrompt("notices/resume/unanswered.md", {
				calls: input.unanswered.join("; "),
				children: input.children?.join("; ") ?? "",
			}),
		);
	const ongoing = ongoingBrief(agent, input.repoKey, input.sessionId);
	if (ongoing.length > 0) facts.push(ongoing.join("\n"));
	const openTasks = openTasksBrief(agent, input.repoKey, input.sessionId);
	if (openTasks.length > 0) facts.push(openTasks.join("\n"));
	const { todo, backlog: proposed } = new BacklogStore(() => agent, input.repoKey).counts().items;
	const away = now - input.lastActive;
	if (facts.length === 0 && away <= LONG_AWAY_MS) return undefined;
	if (input.request)
		facts.push(renderPrompt("notices/resume/last-request.md", { newPrompt: input.newPrompt, request: input.request }));
	if (todo + proposed > 0) facts.push(renderPrompt("notices/resume/backlog-todo.md", { todo, proposed }));
	if (git.dirty > 0)
		facts.push(renderPrompt("notices/resume/uncommitted.md", { count: git.dirty, several: git.dirty !== 1 }));
	const [first, ...rest] = facts;
	const lines = [
		renderPrompt("notices/resume/brief.md", { tag: RESUME_TAG, away: shortDuration(away), first }),
		...rest,
	];
	// The backlog part is capped (`ongoingBrief`); the request and the unanswered calls are whole, and the brief is never cut.
	return lines.join("\n");
}
