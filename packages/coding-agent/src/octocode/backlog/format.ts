import { formatAgo, formatSpan } from "../shared/format.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { refText } from "./row.ts";
import { type BacklogStore, type Item, priorityName } from "./store.ts";
import { type Note, STATES, type State } from "@octocodeai/octocode-contracts/snapshot";
import type { BacklogTask, TaskTally, WorkLink } from "@octocodeai/octocode-contracts/backlogs";
import { taskBlock, taskLine } from "./task-format.ts";
import { refuseExportSecrets } from "./export-secrets.ts";
import { type BacklogCounts, openEpics } from "./counts.ts";
import type { ItemMarks } from "./marks.ts";
import type { AgentRun } from "../../../../db/src/api.ts";

export const STATE_TITLE: Record<State, string> = {
	ongoing: "Ongoing",
	todo: "Todo",
	backlog: "Backlog (triage)",
	done: "Done",
};
/** Board and export order: the flow an item follows, so the board's ←/→ step up/down the sections as drawn. */
export const BOARD_ORDER: readonly State[] = STATES;

/** Who holds an item, from the reader's side: `(you)`, `XX, `(@main-1a2b)`, or nothing. */
function holder(item: Item, self?: string, parents?: ReadonlySet<string>): string {
	if (!item.assignee || item.state !== "ongoing") return "";
	if (item.assignee === self) return " (you)";
	return parents?.has(item.assignee) ? " (coordinator)" : ` (@${visibleControls(item.assignee)})`;
}

/** ` (from B12)` when the item came from another one. */
const fromText = (item: Item): string => (item.from === undefined ? "" : ` (from ${refText(item.from)})`);

/** What the item waits on, or for a done item what needs a second look: ` (blocked by B5)`, ` (needs review: B5 open)`, ` (2 open steps)`. */
function waitText(item: Item, marks: ItemMarks): string {
	const open = item.state === "done" ? [...(marks.blockedBy ?? []), ...(marks.openBelow ?? [])] : [];
	const waiting = item.state === "done" ? "" : marks.blockedBy ? ` (blocked by ${marks.blockedBy.join(", ")})` : "";
	const review = open.length ? ` (needs review: ${open.join(", ")} open)` : "";
	const steps = marks.openSteps ? ` (${marks.openSteps} open step${marks.openSteps === 1 ? "" : "s"})` : "";
	return `${waiting}${review}${steps}`;
}

/**
 * `B14 [ongoing p1 bug] Title #tag ⊂B3 (from B12) (blocked by B5) (2 open steps) (you)`: the type shows unless it is feature, the
 * parent as `⊂B3`; `marks` (from `BacklogStore.marks`) add what the database says: open prerequisites, open steps, the
 * children working on it (`(worked on by kid-1)`), a stale claim.
 */
export function itemLine(item: Item, self?: string, parents?: ReadonlySet<string>, marks: ItemMarks = {}): string {
	const tags = item.tags.map((tag) => ` #${tag}`).join("");
	const type = item.type === "feature" ? "" : ` ${item.type}`;
	const parent = item.parentId && !marks.hideParent ? ` ⊂${item.parentId}` : "";
	const stale = marks.stale ? " (stale: holder ended)" : "";
	const workers = marks.workers ? ` (worked on by ${marks.workers.map(visibleControls).join(", ")})` : "";
	return `${item.ref} [${item.closed ? "closed" : item.state} ${priorityName(item.priority)}${type}] ${visibleControls(item.title)}${tags}${parent}${fromText(item)}${waitText(item, marks)}${holder(item, self, parents)}${workers}${stale}`;
}

const ago = (at: number, now: number) => formatAgo(now - at);

/** Local wall-clock time, `2026-10-12 21:03`. */
function stamp(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Who wrote a note or holds an item, from the reader's side: `you`, `your coordinator`, or the id. */
const who = (id: string, self?: string, parents?: ReadonlySet<string>) =>
	id === self ? "you" : parents?.has(id) ? "your coordinator" : visibleControls(id);

/**
 * When things happened to an item, oldest first: `created 2026-10-09 14:00 (3d ago) by agent · claimed 2h ago by you ·
 * done 5m ago (took 1h55m) · updated 5m ago`.
 */
function timeline(item: Item, now: number, self?: string, parents?: ReadonlySet<string>): string[] {
	const heldBy = item.assignee ? ` by ${who(item.assignee, self, parents)}` : "";
	const parts = [
		`created ${stamp(item.createdAt)} (${ago(item.createdAt, now)}) by ${visibleControls(item.createdBy)}`,
	];
	if (item.startedAt) parts.push(`claimed ${ago(item.startedAt, now)}${item.state === "done" ? "" : heldBy}`);
	else if (item.assignee && item.state !== "done") parts.push(`assignee ${who(item.assignee, self, parents)}`);
	if (item.doneAt)
		parts.push(
			`done ${ago(item.doneAt, now)}${item.startedAt && item.startedAt <= item.doneAt ? ` (took ${formatSpan(item.doneAt - item.startedAt)})` : ""}${heldBy}`,
		);
	if (item.updatedAt !== item.createdAt) parts.push(`updated ${ago(item.updatedAt, now)}`);
	return parts;
}

/** A note's text with later lines indented under its bullet (a change note may carry a whole replaced body). */
const indented = (text: string, indent: string) => visibleControls(text).replace(/\n/g, `\n${indent}`);

/** `- 5m ago you: text` for a note, `- 5m ago you · state todo → ongoing` for a change the store logged. */
function noteLine(note: Note, now: number, self?: string, parents?: ReadonlySet<string>): string {
	return `- ${ago(note.at, now)} ${who(note.author, self, parents)}${note.kind === "change" ? " ·" : ":"} ${indented(note.text, "  ")}`;
}

/** A link target as a reader writes it: a path, item id or URL; other stored resources as `resource:namespace/id`. */
function linkText({ relation, target }: WorkLink): string {
	const text =
		target.resource === "files"
			? target.path
			: target.resource === "backlogs"
				? target.id
				: target.resource === "external"
					? target.url
					: `${target.resource}:${target.namespace}/${target.id}`;
	return `- ${relation}: ${visibleControls(text)}`;
}

/** The item's saved fields in reading order, empty ones omitted: Goal, Where, Why, Evidence (one `-` line per entry), Links, Plan. */
function itemFields(item: Item): string[] {
	const lines: string[] = [`Type: ${item.type}`];
	if (item.parentId) lines.push(`Parent: ${item.parentId}`);
	if (item.dependsOn.length) lines.push(`Depends on: ${item.dependsOn.map((ref) => ref.id).join(", ")}`);
	if (item.closed)
		lines.push(
			`Closed (${item.closed.kind}${item.closed.of ? ` of ${item.closed.of}` : ""}): ${visibleControls(item.closed.text)}`,
		);
	const completion = item.completions.at(-1);
	if (completion)
		lines.push(
			`Result (completion ${completion.id}): ${visibleControls(completion.summary)}`,
			`Verification: ${completion.verification.status} — ${visibleControls(completion.verification.summary)}`,
			`Files: ${completion.files.map((file) => visibleControls(file.path)).join(", ") || "none"}`,
		);
	if (completion?.lesson) lines.push(`Lesson: ${visibleControls(completion.lesson)}`);

	if (item.goal) lines.push(`Goal: ${visibleControls(item.goal)}`);
	if (item.paths.length) lines.push(`Where: ${item.paths.map((path) => visibleControls(path)).join(", ")}`);
	if (item.why) lines.push(`Why: ${indented(item.why, "  ")}`);
	if (item.evidence.length) lines.push("Evidence:", ...item.evidence.map((entry) => `- ${visibleControls(entry)}`));
	if (item.links.length) lines.push("Links:", ...item.links.map(linkText));
	if (item.plan) lines.push(`Plan: ${indented(item.plan, "  ")}`);
	return lines;
}

interface DetailOptions {
	noteOffset?: number;
	/** The notes are only the agents' and users' (no store-logged changes): the heading says so. */
	notesOnly?: boolean;
	self?: string;
	/** A subagent's parent sessions, shown as `(coordinator)`. */
	parents?: ReadonlySet<string>;
	/** Show the version (the board uses it for stale-edit checks; the tool has no use for it). */
	version?: boolean;
	/** The item this one came from, and the items that came from it (all of them). */
	origin?: Item;
	derived?: readonly Item[];
	/** The item's tasks, and for an epic the state derived from its items (shown when it differs from the stored one). */
	tasks?: readonly BacklogTask[];
	epicState?: State;
	/** An epic's child items (any depth), listed with their state and a done count. */
	children?: readonly Item[];
	/** The agent runs started for the item: shown as a `Runs` block (agent, how it ended, outcome, cost). */
	runs?: readonly AgentRun[];
	/** Marks by item ref for the item and the items listed with it. */
	marks?: ReadonlyMap<string, ItemMarks>;
}

/** Child lines shown before the rest is summarised. */
const CHILD_LINES = 40;

const RUN_LINES = 10;

/** The runs of agents started for the item, newest first: who, how it ended, what it reported and what it cost. */
function runsBlock(runs: readonly AgentRun[], now: number): string[] {
	if (runs.length === 0) return [];
	const lines = runs.slice(0, RUN_LINES).map((run) => {
		const ended = run.endedAt === undefined ? "running" : `${run.endReason ?? "ended"} ${formatAgo(now - run.endedAt)}`;
		const outcome = run.outcome ? ` · ${run.outcome}` : "";
		const cost = `$${run.cost.toFixed(run.cost < 1 ? 3 : 2)}${run.unpriced ? "+" : ""}`;
		return `- ${run.agentId} (${run.profile ?? run.kind}) ${ended}${outcome} · ${cost}`;
	});
	if (runs.length > RUN_LINES) lines.push(`- … and ${runs.length - RUN_LINES} more`);
	return ["", `Runs (${runs.length}):`, ...lines];
}

/** The whole item: header, goal, where, why, evidence, plan, times, origin, body, derived items and its notes. */
export function itemDetail(
	item: Item,
	notes: Note[],
	totalNotes: number,
	now: number,
	options: DetailOptions = {},
): string {
	const { self, parents } = options;
	const meta = [...timeline(item, now, self, parents), options.version ? `version ${item.version}` : ""].filter(
		Boolean,
	);
	const line = (shown: Item, hideParent = false) =>
		itemLine(shown, self, parents, { ...options.marks?.get(shown.ref), ...(hideParent ? { hideParent } : {}) });
	const lines = [line(item), ...itemFields(item), meta.join(" · ")];
	if (item.type === "epic" && options.epicState && options.epicState !== item.state)
		lines.splice(1, 0, `State from its items: ${options.epicState}`);
	if (options.origin) lines.push(`From: ${line(options.origin)}`);
	if (item.body) lines.push("", visibleControls(item.body));
	if (options.children?.length) {
		const shown = options.children.slice(0, CHILD_LINES);
		const done = options.children.filter((child) => child.state === "done").length;
		lines.push(
			"",
			`Items (${done}/${options.children.length} done):`,
			...shown.map((child) => `- ${line(child, child.parentId === item.ref)}`),
		);
		if (options.children.length > shown.length)
			lines.push(`- … and ${options.children.length - shown.length} more: backlogPlan list underEpic ${item.ref}`);
	}
	if (options.derived?.length)
		lines.push("", `Derived items (${options.derived.length}):`, ...options.derived.map((child) => `- ${line(child)}`));
	lines.push(...taskBlock(options.tasks ?? []));
	lines.push(...runsBlock(options.runs ?? [], now));
	if (notes.length > 0) {
		const offset = options.noteOffset ?? 0;
		const heading = options.notesOnly ? "Notes" : "Notes and changes";
		const label =
			offset > 0
				? `${heading} (${offset + 1}–${offset + notes.length} newest of ${totalNotes}):`
				: totalNotes > notes.length
					? `${heading} (last ${notes.length} of ${totalNotes}):`
					: `${heading}:`;
		lines.push("", label, ...notes.map((note) => noteLine(note, now, self, parents)));
	}
	return lines.join("\n");
}

/**
 * Every item grouped by state, for a headless `/backlog`: an item lists its open tasks beneath it, an epic shows the state
 * derived from its items, and this session's own tasks follow.
 */
export function boardText(store: BacklogStore, self?: string): string {
	const { items } = store.list({ states: STATES });
	const closed = store.counts().closed;
	const open = store.tasks.list({ states: ["todo", "ongoing"] });
	const own = open.filter((task) => task.owner.kind === "session" && task.owner.id === self);
	if (items.length === 0 && own.length === 0 && closed === 0)
		return "The backlog is empty. Add an item: /backlog add <title>";
	const derived = (item: Item) => {
		const shown = store.epicState(item);
		return item.type === "epic" && shown !== item.state ? ` (items say ${shown})` : "";
	};
	const sections = BOARD_ORDER.flatMap((state) => {
		const rows = items.filter((item) => item.state === state);
		return rows.length === 0
			? []
			: [
					`${STATE_TITLE[state]} (${rows.length})`,
					...rows.flatMap((item) => [
						`  ${itemLine(item, self)}${derived(item)}`,
						...open
							.filter((task) => task.owner.kind === "item" && task.owner.ref === item.ref)
							.map((task) => `    ${taskLine(task, { owner: false })}`),
					]),
				];
	});
	if (closed > 0) sections.push(`Closed (${closed}, hidden): list with states ["closed"]`);
	if (own.length > 0)
		sections.push(`Session steps (${own.length})`, ...own.map((task) => `  ${taskLine(task, { owner: false })}`));
	return sections.join("\n");
}

/** How many open tasks this session tracks: its own, and those under the items it holds (ongoing, assigned to `self`). */
export function openTaskCount(store: BacklogStore, self: string): number {
	const tally = sessionTaskTally(store, self);
	return tally.todo + tally.ongoing;
}

/** This session's checklist progress: its session tasks and the tasks of ongoing items it holds. */
export function sessionTaskTally(store: BacklogStore, self: string): TaskTally {
	const { items, sessions } = store.tasks.counts();
	const total: TaskTally = { todo: 0, ongoing: 0, done: 0, dropped: 0 };
	const held = store.list({ states: ["ongoing"], assignees: [self] }).items;
	for (const tally of [sessions[self], ...held.map((item) => items[item.ref])]) {
		if (!tally) continue;
		for (const state of ["todo", "ongoing", "done", "dropped"] as const) total[state] += tally[state];
	}
	return total;
}

/** Dropped steps stay in the denominator and are named separately; an empty checklist has no progress chip. */
export function taskProgressText(tally: TaskTally): string | undefined {
	const total = tally.todo + tally.ongoing + tally.done + tally.dropped;
	if (!total) return undefined;
	return `${tally.done}/${total} steps done${tally.dropped ? ` · ${tally.dropped} dropped` : ""}`;
}

/** Keep the web workspace discoverable even when there are no open items; append live backlog counts and this session's open tasks. */
export function countsText(counts: BacklogCounts, tasks = 0): string {
	const { items } = counts;
	const epics = openEpics(counts);
	const parts = [
		items.ongoing ? `${items.ongoing} ongoing` : "",
		items.todo ? `${items.todo} todo` : "",
		items.backlog ? `${items.backlog} to triage` : "",
		epics ? `${epics} epic${epics === 1 ? "" : "s"}` : "",
		counts.closed ? `${counts.closed} closed` : "",
		tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return ["/web · backlogs & activity", ...parts].join(" · ");
}

/** Markdown snapshot of the whole board with every note, for `<repo>/.octocode/code/backlog.md`. Nothing reads it back. */
export function exportMarkdown(store: BacklogStore, repoName: string, now: number): string {
	const { items } = store.list();
	const notes = new Map(items.map((item) => [item.ref, store.notes(item, -1)]));
	refuseExportSecrets(
		repoName,
		items.map((item) => ({ ...item, notes: notes.get(item.ref)! })),
		"/backlog export",
	);
	const lines = [
		`<!-- Generated by Octocode (/backlog export) at ${new Date(now).toISOString()}. A snapshot: edits here are not read back. -->`,
		`# Backlog — ${visibleControls(repoName)}`,
		"",
	];
	if (items.length === 0) lines.push("_Empty._", "");
	const groups = [
		...BOARD_ORDER.map((state) => ({
			title: STATE_TITLE[state],
			rows: items.filter((i) => i.state === state && !i.closed),
		})),
		{ title: "Closed", rows: items.filter((item) => item.closed) },
	];
	for (const { title, rows } of groups) {
		if (rows.length === 0) continue;
		lines.push(`## ${title} (${rows.length})`, "");
		for (const item of rows) {
			const tags = item.tags.map((tag) => ` #${tag}`).join("");
			const owner = item.assignee ? ` — ${visibleControls(item.assignee)}` : "";
			lines.push(
				`- **${item.ref}** [${priorityName(item.priority)}] ${visibleControls(item.title)}${tags}${fromText(item)}${owner}`,
			);
			lines.push(
				...itemFields(item)
					.flatMap((field) => field.split("\n"))
					.map((line) => `  ${line}`),
			);
			const times = [
				`created ${stamp(item.createdAt)} by ${visibleControls(item.createdBy)}`,
				item.startedAt ? `claimed ${stamp(item.startedAt)}` : "",
				item.doneAt ? `${item.closed ? "closed" : "done"} ${stamp(item.doneAt)}` : "",
			];
			lines.push(`  _${times.filter(Boolean).join(" · ")}_`);
			for (const line of item.body ? visibleControls(item.body).split("\n") : []) lines.push(`  ${line}`.trimEnd());
			for (const note of notes.get(item.ref)!) {
				const heading = `${new Date(note.at).toISOString().slice(0, 16).replace("T", " ")} ${visibleControls(note.author)}${note.kind === "change" ? " ·" : ":"}`;
				lines.push(...`  - ${heading} ${indented(note.text, "    ")}`.split("\n").map((line) => line.trimEnd()));
			}
		}
		lines.push("");
	}
	return lines.join("\n");
}

export const isState = (word: string): word is State => (STATES as readonly string[]).includes(word);
