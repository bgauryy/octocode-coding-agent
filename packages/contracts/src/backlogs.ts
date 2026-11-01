import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/** Item types, epic first; the one source for schemas, filters and editors. `feature` was called `task` before tasks became their own entity. */
export const ITEM_TYPES = ["epic", "feature", "bug", "research"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
/** The type an item gets when none is named. */
export const DEFAULT_ITEM_TYPE: ItemType = "feature";
/**
 * Names an older build or caller used for an item type, with the type each means now. Accepted as input for one
 * release (`itemTypeInput`); never stored or returned.
 */
export const LEGACY_ITEM_TYPES: Readonly<Record<string, ItemType>> = { task: "feature" };
/**
 * An item type as input: a current type as it is, a legacy name mapped to its replacement (`legacy` names the old
 * name so the caller can tell the user), anything else undefined. The `task` tool and the store both accept
 * `task` through this for one release.
 */
export function itemTypeInput(type: string): { type: ItemType; legacy?: string } | undefined {
	if ((ITEM_TYPES as readonly string[]).includes(type)) return { type: type as ItemType };
	const current = Object.hasOwn(LEGACY_ITEM_TYPES, type) ? LEGACY_ITEM_TYPES[type] : undefined;
	return current ? { type: current, legacy: type } : undefined;
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
