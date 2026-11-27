import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { renderPrompt } from "../../core/prompt-template.ts";
import { type AgentDb, backlog, workspaces } from "../../../../db/src/api.ts";
import { clip } from "../shared/text.ts";
import { priorityName } from "./item.ts";
import { BacklogStore } from "./store.ts";

/** The workspace's open items and the audit cursor, read in one statement (`backlog.snapshot`). */
type Snapshot = ReturnType<typeof backlog.snapshot>;
type SnapshotItem = Snapshot["items"][number];

/** Refs the index names in all (the active one included); the rest are counted. */
const MAX_REFS = 10;
const TITLE_CHARS = 48;
const GOAL_CHARS = 60;
const STEP_CHARS = 60;

const flat = (text: string, chars: number) => clip(visibleControls(text).replace(/\s+/g, " ").trim(), chars);
const ref = (item: SnapshotItem) => `B${item.seq}`;

/**
 * The item this agent works on: a subagent's delegated item (`item`), else the most urgent ongoing item `session` holds
 * (the snapshot is ordered by priority).
 */
export function activeItem(snap: Snapshot, session: string, item?: string): SnapshotItem | undefined {
	if (item) return snap.items.find((row) => ref(row) === item);
	const held = heldItems(snap, session);
	// A held epic and its held child: the child is the work in hand.
	return held.find((row) => !held.some((other) => other.parent_seq === row.seq)) ?? held[0];
}

function heldItems(snap: Snapshot, session: string): SnapshotItem[] {
	return snap.items.filter((row) => row.state === "ongoing" && row.assignee === session);
}

/** What follows the active item's ref: ` — goal: … — next: T3 …`, each part only when there is one. */
export function activeDetail(agent: AgentDb, repo: string, active: SnapshotItem): string {
	const goal = active.goal.trim() ? ` \u2014 goal: ${flat(active.goal, GOAL_CHARS)}` : "";
	const next = new BacklogStore(() => agent, repo).tasks
		.list({ item: ref(active), states: ["ongoing", "todo"] })
		.toSorted((a, b) => (a.state === b.state ? 0 : a.state === "ongoing" ? -1 : 1))[0];
	return `${goal}${next ? ` \u2014 next: ${next.ref} ${flat(next.goal, STEP_CHARS)}` : ""}`;
}

const entry = (item: SnapshotItem, session: string, priority: boolean) =>
	`${ref(item)} v${item.version} ${item.state}${priority ? ` ${priorityName(item.priority)}` : ""} "${flat(item.title, TITLE_CHARS)}"${
		item.state === "ongoing" ? (item.assignee === session ? " (yours)" : " (held elsewhere)") : ""
	}`;

/**
 * The index of a span (resume, after compaction): counts, the ongoing items with the active one inline, then the most
 * urgent open ones, each with its `version`, up to `MAX_REFS` refs and a count of the rest. Undefined when the
 * workspace is unknown or has nothing open.
 */
export function backlogIndex(agent: AgentDb, repo: string, session: string, item?: string): string | undefined {
	if (!workspaces.byId(agent.db, repo)) return undefined;
	const snap = backlog.snapshot(agent.db, repo);
	if (snap.items.length === 0) return undefined;
	const active = activeItem(snap, session, item);
	const ongoing = snap.items
		.filter((row) => row.state === "ongoing")
		.toSorted(
			(a, b) =>
				Number(b === active) - Number(a === active) || Number(b.assignee === session) - Number(a.assignee === session),
		);
	const open = snap.items.filter((row) => row.state !== "ongoing");
	const shownOngoing = ongoing
		.slice(0, MAX_REFS)
		.map((row) => entry(row, session, false) + (row === active ? activeDetail(agent, repo, row) : ""));
	const shownOpen = open.slice(0, Math.max(0, MAX_REFS - shownOngoing.length)).map((row) => entry(row, session, true));
	const rest = snap.items.length - shownOngoing.length - shownOpen.length;
	return renderPrompt("notices/backlog-digest.md", {
		open: snap.items.length,
		running: snap.items.filter((row) => row.state === "ongoing").length,
		todo: snap.items.filter((row) => row.state === "todo").length,
		proposed: snap.items.filter((row) => row.state === "backlog").length,
		ongoing: shownOngoing.join("; "),
		top: [...shownOpen, ...(rest > 0 ? [`${rest} more`] : [])].join("; "),
	});
}

/** `active B42 v7 ongoing · open 5 · changed: B43`: the per-turn task line; `changed` lists foreign changes since the last line. */
export function taskLine(snap: Snapshot, session: string, changed: readonly string[], item?: string): string {
	const active = activeItem(snap, session, item);
	const others = item ? [] : heldItems(snap, session).filter((row) => row !== active);
	const more = others.length > 0 ? ` (+${others.map(ref).join(", ")})` : "";
	return [
		...(active ? [`active ${ref(active)} v${active.version} ${active.state}${more}`] : []),
		`open ${snap.items.length}`,
		...(changed.length > 0 ? [`changed: ${changed.join(", ")}`] : []),
	].join(" \u00b7 ");
}
