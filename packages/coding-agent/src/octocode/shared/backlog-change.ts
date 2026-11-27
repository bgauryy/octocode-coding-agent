/**
 * The channel (`api.channels`) on which the backlog announces each audited change to the hooks domain, and the change
 * itself. The backlog domain emits, the hooks domain turns it into the TaskCreated and BacklogChange hooks; neither imports the other.
 */
export const BACKLOG_CHANGE_CHANNEL = "octocode:backlog-change";

/** Every kind of change an audited write can be, in the order a reader lists them. */
export const CHANGE_KINDS = [
	"created",
	"claimed",
	"released",
	"reassigned",
	"done",
	"closed",
	"reopened",
	"paths_changed",
	"blocked",
	"unblocked",
	"note",
	"step",
	"edited",
] as const;

/** What an audited write did to an item, read from its audit row. */
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** One audited change of one item. */
export interface BacklogChange {
	/** The audit row's id: the cursor. */
	id: number;
	/** The item, `B12`. */
	ref: string;
	kind: ChangeKind;
	/** The actor's id (a session or agent id, or the user). */
	by: string;
	/** How the write came in: the tool, the web board or `/backlog`. */
	surface?: string;
	state?: string;
	/** The state before the change, when the row had one. */
	beforeState?: string;
	assignee?: string | null;
	beforeAssignee?: string | null;
	/** The item's epic after the change. */
	parent?: string | null;
	paths: string[];
	beforePaths: string[];
	title?: string;
	version?: number;
	/** `blocked` and `unblocked`: the prerequisite the link names. */
	target?: string;
	/** `note`: the comment. */
	text?: string;
}

/** What a listener on `BACKLOG_CHANGE_CHANNEL` receives. */
export interface BacklogChangeNotice {
	change: BacklogChange;
	/** Whether this process wrote it (its session or agent id is the actor). */
	own: boolean;
}
