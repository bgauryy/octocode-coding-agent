import type { ItemType, BacklogRef, WorkLink, Completion } from "./backlogs.ts";
export const STATES = ["backlog", "todo", "ongoing", "done"] as const;
export type State = (typeof STATES)[number];
export type NoteKind = "note" | "change";
export interface Note { at: number; author: string; kind: NoteKind; text: string; }
export interface BacklogComment { id: number; backlogId: string; at: number; author: string; text: string; }
export interface BacklogAudit { id: number; backlogId: string; at: number; actor: { id: string; kind?: string }; action: string; entity: string; before: unknown; after: unknown; }

export interface SnapshotItem {
	comments?: BacklogComment[];
	audits?: BacklogAudit[];
	type?: ItemType;
	parentId?: string;
	dependsOn?: BacklogRef[];
	links?: WorkLink[];
	completions?: Completion[];
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
}

