import { type ItemType, type BacklogRef, type Completion, type WorkLink } from "@octocodeai/octocode-contacts/backlogs";
import type { State } from "@octocodeai/octocode-contacts/snapshot";
import { USER_AUTHOR } from "../agentdb/author.ts";
import { storedSecret, storedText } from "../shared/sanitize.ts";
import { cutText } from "../shared/util.ts";

export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
type Priority = (typeof PRIORITIES)[number];

export interface Item {
	type: ItemType;
	parentId?: string;
	dependsOn: BacklogRef[];
	links: WorkLink[];
	completions: Completion[];
	/** Database row id (notes hang from it). */
	rowId: number;
	seq: number;
	/** `B<seq>`. */
	ref: string;
	title: string;
	/** What done means: the observable result or check that closes the item. */
	goal: string;
	/** Free text from before the structured fields; read-only (no writer sets it any more). */
	body: string;
	/** Repo-relative files, directories or components the work touches. */
	paths: string[];
	/** Why it matters: the problem and who it affects. */
	why: string;
	/** Observations that justify it: `path:line — what it shows`, or a command and its result; a bare path or URL is a link. */
	evidence: string[];
	/** The intended approach and steps. */
	plan: string;
	state: State;
	priority: number;
	tags: string[];
	assignee?: string;
	createdBy: string;
	sourceSession?: string;
	createdAt: number;
	updatedAt: number;
	/** When the item was last claimed (moved to ongoing, or taken over); kept when it is done, cleared when released. */
	startedAt?: number;
	doneAt?: number;
	/** The item this one came from, by number (`B<from>`). */
	from?: number;
	version: number;
}

/** Who is acting: the id written as assignee and note author, and for a subagent the sessions of its parent. */
export interface Actor {
	id: string;
	kind?: "human" | "agent";
	/** Set for a subagent: its parent's sessions, the only assignees whose items it may update (it never claims). */
	owners?: ReadonlySet<string>;
	/** Set for a subagent its parent started for one item (`B12`): the only item it may update; it may still propose. */
	item?: string;
}

/** Who the agent database records as making a change: `actor`, else the user; without a kind, the user is human. */
export const auditActor = (actor: Actor | undefined): { id: string; kind: "human" | "agent" } => ({
	id: actor?.id ?? USER_AUTHOR,
	kind: actor?.kind ?? (actor?.id === USER_AUTHOR || !actor ? "human" : "agent"),
});

export class BacklogError extends Error {
	readonly current?: Item;
	constructor(message: string, current?: Item) {
		super(message);
		this.current = current;
	}
}

/** A title as stored: one line (a title is a one-line summary; a newline would break lists, the board and the export). */
export const storedTitle = (title: string | undefined): string => storedText(title).replace(/\s+/g, " ");

/** `B12`, `b12`, `#12` or `12` → 12. */
export function parseRef(ref: string): number | undefined {
	const match = /^\s*(?:[bB]|#)?(\d{1,9})\s*$/.exec(ref);
	return match ? Number(match[1]) : undefined;
}

/** Tags as stored: lower-case words of letters, digits, `.`, `_`, `-`, without a leading `#`, deduplicated. */
export function cleanTags(tags: readonly string[]): string[] {
	const words = tags
		.map((tag) =>
			cutText(
				tag
					.trim()
					.replace(/^#+/, "")
					.toLowerCase()
					.replace(/[^\p{L}\p{N}._-]+/gu, "-")
					.replace(/^-+|-+$/g, ""),
				32,
				{ chars: true },
			),
		)
		.filter(Boolean);
	return [...new Set(words)];
}

/** A list as stored: one entry per line, each entry one trimmed line, empty entries and repeats dropped. */
export function cleanList(entries: readonly string[]): string[] {
	return [...new Set(entries.map((entry) => storedText(entry).replace(/\s+/g, " ")).filter(Boolean))];
}

/**
 * Refuses text that looks like a credential (the backlog is plain text in the home database). Checked on the
 * sanitized text, the form that is stored, so an invisible character cannot split a token past the check.
 */
export function refuseSecrets(fields: Record<string, string | readonly string[] | undefined>): void {
	const found = storedSecret(fields);
	if (found) throw new BacklogError(`Not stored: the ${found.name} ${found.problem.replace(/^it /, "")}.`);
}

export const priorityName = (priority: number): Priority => PRIORITIES[priority] ?? "p2";

export function clampPriority(priority: number | undefined): number {
	return priority === undefined || !Number.isInteger(priority) ? 2 : Math.min(3, Math.max(0, priority));
}
