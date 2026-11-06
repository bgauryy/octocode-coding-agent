import type { ItemType, BacklogRef, WorkLink, Completion, BacklogTask, Closed } from "./backlogs.ts";
export const STATES = ["backlog", "todo", "ongoing", "done"] as const;
export type State = (typeof STATES)[number];
/** What a list may filter by: the states, and `closed` (items closed without being done; every one is `done` underneath). */
export const LIST_STATES = [...STATES, "closed"] as const;
export type ListState = (typeof LIST_STATES)[number];

/**
 * What an epic shows, from its children's states: no children keeps `stored`; all done is done; any ongoing is ongoing;
 * any todo is todo; otherwise (children still in the backlog, or backlog and done mixed) backlog. The stored state is
 * only set when the epic is closed with its summary.
 */
export function deriveEpicState(stored: State, children: readonly State[]): State {
	if (!children.length) return stored;
	if (children.every((state) => state === "done")) return "done";
	if (children.includes("ongoing")) return "ongoing";
	return children.includes("todo") ? "todo" : "backlog";
}
export type NoteKind = "note" | "change";
export interface Note {
	at: number;
	author: string;
	kind: NoteKind;
	text: string;
}
export interface BacklogComment {
	id: number;
	backlogId: string;
	at: number;
	author: string;
	text: string;
}
export interface BacklogAudit {
	id: number;
	backlogId: string;
	at: number;
	actor: { id: string; kind?: string; surface?: string };
	action: string;
	entity: string;
	before: unknown;
	after: unknown;
}

export interface SnapshotItem {
	comments?: BacklogComment[];
	type?: ItemType;
	parentId?: string;
	dependsOn?: BacklogRef[];
	links?: WorkLink[];
	completions?: Completion[];
	/** The item's tasks in position order. */
	tasks?: BacklogTask[];
	/** What an epic shows, derived from its children (`deriveEpicState`); absent for other types. */
	epicState?: State;
	children?: string[];
	blockedBy?: string[];
	needsReview?: boolean;
	ref: string;
	title: string;
	goal: string;
	body: string;
	paths: string[];
	why: string;
	evidence: string[];
	plan: string;
	state: State;
	priority: string;
	/** Manual position in its column (ascending); absent until the item is first ordered by hand. */
	rank?: number;
	tags: string[];
	assignee?: string;
	/** Whether the assignee is a running session at snapshot time (the writer's own session counts). */
	assigneeLive?: boolean;
	createdBy: string;
	sourceSession?: string;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	doneAt?: number;
	/** Set when the item was closed instead of completed (it reads as done: it has no completion). */
	closed?: Closed;
	version: number;
	/** The ref of the item this one came from. */
	from?: string;
	/** The refs of the items that came from this one. */
	derived: string[];
	/** Every note and change, oldest first. */
	notes: Note[];
}

/** The whole backlog of one repository as the HTML page embeds it: every item in every state, with every note. */
export interface Snapshot {
	repo: string;
	generatedAt: number;
	states: readonly State[];
	idleMs: number;
	items: SnapshotItem[];
	/** Tasks that belong to a session and no item, by session then position. */
	sessionTasks?: BacklogTask[];
}
