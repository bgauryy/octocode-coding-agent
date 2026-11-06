import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/** Item types, epic first; the one source for schemas, filters and editors. */
export const ITEM_TYPES = ["epic", "feature", "bug", "research"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
/** The type an item gets when none is named. */
export const DEFAULT_ITEM_TYPE: ItemType = "feature";
/** Whether `type` names an item type. */
export const isItemType = (type: string): type is ItemType => (ITEM_TYPES as readonly string[]).includes(type);

/** Why an item was closed instead of completed: no longer needed, covered by another item, or deliberately not done. */
export const CLOSE_KINDS = ["obsolete", "duplicate", "wont_do"] as const;
export type CloseKind = (typeof CLOSE_KINDS)[number];

/** What closing an item takes: the kind, the reason in words, and for a duplicate the item it duplicates (`B12`). */
export const CloseInputSchema = Type.Object(
	{
		kind: StringEnum(CLOSE_KINDS),
		text: Type.String({ description: "Reason" }),
		of: Type.Optional(Type.String({ description: "duplicate: the original" })),
	},
	{ additionalProperties: false },
);
export type CloseInput = Static<typeof CloseInputSchema>;

/** A closed item's record: the close input plus who closed it and when. A closed item is `done` without a completion. */
export interface Closed extends CloseInput {
	by: string;
	at: number;
}

/** Task states: `todo` and `ongoing` are open; `done` and `dropped` are closed. */
export const TASK_STATES = ["todo", "ongoing", "done", "dropped"] as const;
export type TaskState = (typeof TASK_STATES)[number];
/** Whether a task in `state` still has work in it (it blocks closing its item). */
export const isOpenTask = (state: TaskState): boolean => state === "todo" || state === "ongoing";

/** Who a task belongs to: exactly one backlog item (`B12`) or exactly one session. */
export type TaskOwner = { kind: "item"; ref: string } | { kind: "session"; id: string };

/**
 * A task: a small step with a goal and a reason, no triage, no completion record. It lives under one item, or under one
 * session when no item holds the work (a session task stays with its session until promoted to an item).
 */
export interface BacklogTask {
	/** `T<seq>`; numbered per repository and never reused. */
	ref: string;
	seq: number;
	/** Database row id. */
	rowId: number;
	goal: string;
	/** Why the step is needed; may be empty. */
	reason: string;
	state: TaskState;
	/** Order within the owner (0 first); tasks of one owner are listed by it. */
	position: number;
	owner: TaskOwner;
	/** Who is doing it: set when it is `ongoing`. */
	assignee?: string;
	/** What was done or why it was dropped; written when it closes, may be empty. */
	result: string;
	createdAt: number;
	updatedAt: number;
	/** When it was marked `done`. */
	doneAt?: number;
	version: number;
}
/** Tasks per state. */
export type TaskTally = Record<TaskState, number>;
/** Priority names in rank order; an item stores the index (`p0` is 0, most urgent). */
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export const BacklogRefSchema = Type.Object(
	{ resource: Type.Literal("backlogs"), repositoryKey: Type.String(), id: Type.String() },
	{ additionalProperties: false },
);
export const ReferenceSchema = Type.Union([
	BacklogRefSchema,
	Type.Object(
		{
			resource: Type.Literal("files"),
			repositoryKey: Type.String(),
			path: Type.String(),
			revision: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			resource: StringEnum(["sessions", "messages", "reports", "memories", "artifacts"] as const),
			namespace: Type.String(),
			id: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object({ resource: Type.Literal("external"), url: Type.String() }, { additionalProperties: false }),
]);
export const LinkSchema = Type.Object(
	{
		relation: StringEnum(["related", "derived_from", "evidence", "output"] as const),
		target: ReferenceSchema,
	},
	{ additionalProperties: false },
);
export const CompletionSchema = Type.Object(
	{
		summary: Type.String(),
		files: Type.Array(
			Type.Object(
				{
					path: Type.String(),
					repositoryKey: Type.Optional(Type.String()),
					role: StringEnum(["changed", "reviewed", "produced"] as const),
					revision: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
		verification: Type.Object(
			{
				status: StringEnum(["passed", "failed", "not_run", "not_applicable"] as const),
				summary: Type.String(),
			},
			{ additionalProperties: false },
		),
		lesson: Type.Optional(Type.String()),
		operationKey: Type.String(),
		replaces: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);
export const EntityFields = {
	type: Type.Optional(StringEnum(ITEM_TYPES, { description: "Default feature; epic groups work." })),
	parentId: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: "Parent ID; null clears.",
		}),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.Union([Type.String(), BacklogRefSchema]), {
			description: "Prerequisites; [] clears.",
		}),
	),
	links: Type.Optional(
		Type.Array(LinkSchema, {
			description: "Replace related/evidence links.",
		}),
	),
	completion: Type.Optional({
		...CompletionSchema,
		description:
			"Done result; operationKey deduplicates retries; on a done item it corrects the latest completion (replaces names it; omitted means the latest).",
	}),
	version: Type.Optional(Type.Integer({ description: "Version from get." })),
};
export const EntityFieldsSchema = Type.Object(EntityFields, { additionalProperties: false });
export type EntityInput = Static<typeof EntityFieldsSchema>;
export type BacklogRef = Static<typeof BacklogRefSchema>;
export type WorkLink = Static<typeof LinkSchema>;
type CompletionInput = Static<typeof CompletionSchema>;
export type Completion = CompletionInput & {
	id: number;
	actor: string;
	at: number;
	version: number;
	goal: string;
};

/**
 * Path search over backlog items, shared by the `backlog` tool and the web board. A query names a file or a folder;
 * an item matches by what it names in `paths`, in `evidence` text (`path:line — what`) or in a file link.
 */

/** How an item's path relates to the query, best first: the same file, a folder holding it, a path under the query folder, or a link/evidence mention. */
export type PathMatchKind = "exact" | "folder" | "under" | "mention";

export interface PathMatch {
	kind: PathMatchKind;
	/** Segments of the containing folder (kind `folder`; the deeper folder ranks first), else 0. */
	depth: number;
	/** Why the item matched, e.g. `folder packages/db/ in Where`. */
	reason: string;
}

export interface PathSearchable {
	paths: readonly string[];
	evidence: readonly string[];
	links?: readonly WorkLink[];
}

const RANK: Record<PathMatchKind, number> = { exact: 0, folder: 1, under: 2, mention: 3 };
const LINE_SUFFIX = /:\d+(?:[-:]\d+)*$/;

/** A repository path as segments joined by `/`: no `./`, trailing slash, `:line` suffix or Windows separators; `""` is the repository root. */
export function normalizeRepoPath(input: string): string {
	let text = input
		.trim()
		.replace(/\\/g, "/")
		.replace(LINE_SUFFIX, "")
		.replace(/\/{2,}/g, "/");
	while (text.startsWith("./")) text = text.slice(2);
	text = text.replace(/\/+$/, "");
	return text === "." ? "" : text;
}

/** Whether `text` reads as a path rather than a word: it has a separator, or a leading `./`. */
export function looksLikePath(text: string): boolean {
	const trimmed = text.trim();
	return !/\s/.test(trimmed) && /[\\/]/.test(trimmed);
}

/** How `entry` relates to `query` (both normalized and non-empty), on whole path segments: `src/a` is not `src/ab`. */
function relate(entry: string, query: string): { kind: "exact" | "folder" | "under"; depth: number } | undefined {
	if (!entry) return undefined;
	if (entry === query) return { kind: "exact", depth: 0 };
	if (query.startsWith(`${entry}/`)) return { kind: "folder", depth: entry.split("/").length };
	if (entry.startsWith(`${query}/`)) return { kind: "under", depth: 0 };
	return undefined;
}

/** The path an evidence entry starts with, when its first word is one (`src/a.ts:42 — what`); a plain word is not. */
function evidencePath(entry: string): string {
	const word = entry.trim().split(/\s+/, 1)[0] ?? "";
	return /[/.]/.test(word) ? normalizeRepoPath(word) : "";
}

/** Order of matches: kind, then deeper folder first. */
export function comparePathMatch(a: PathMatch, b: PathMatch): number {
	return RANK[a.kind] - RANK[b.kind] || b.depth - a.depth;
}

/** The best match of `item` for any of `queries` (a query that normalizes to nothing is skipped), or undefined. */
export function matchPaths(item: PathSearchable, queries: readonly string[]): PathMatch | undefined {
	const wanted = queries.map(normalizeRepoPath).filter(Boolean);
	let best: PathMatch | undefined;
	const offer = (match: PathMatch) => {
		if (!best || comparePathMatch(match, best) < 0) best = match;
	};
	for (const query of wanted) {
		for (const raw of item.paths) {
			const found = relate(normalizeRepoPath(raw), query);
			if (!found) continue;
			const reason =
				found.kind === "exact"
					? `exact path ${raw.trim()} in Where`
					: found.kind === "folder"
						? `folder ${raw.trim()} in Where holds ${query}`
						: `${raw.trim()} in Where is under ${query}`;
			offer({ ...found, reason });
		}
		const mentions: Array<[string, string]> = [
			...item.evidence.map((entry): [string, string] => [
				evidencePath(entry),
				`evidence ${entry.trim().split(/\s+/, 1)[0]}`,
			]),
			...(item.links ?? []).flatMap((link): Array<[string, string]> =>
				link.target.resource === "files"
					? [[normalizeRepoPath(link.target.path), `${link.relation} link ${link.target.path}`]]
					: [],
			),
		];
		for (const [entry, reason] of mentions) {
			const found = relate(entry, query);
			if (found) offer({ kind: "mention", depth: 0, reason });
		}
	}
	return best;
}
