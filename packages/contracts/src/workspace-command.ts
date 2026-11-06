import { Type, type Static } from "typebox";
import { CLOSE_KINDS, TASK_STATES } from "./backlogs.ts";
import { StringEnum } from "./schema.ts";
import { STATES } from "./snapshot.ts";

/** The item types a promoted task may become: every item type but the epic, which takes no tasks. */
const PROMOTED_TYPES = ["feature", "bug", "research"] as const;

export const WorkspaceCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		action: StringEnum(["message", "work", "delegate", "stop"] as const),
		backlogId: Type.Optional(Type.String()),
		version: Type.Optional(Type.Integer()),
		to: Type.Optional(Type.String()),
		text: Type.Optional(Type.String({ maxLength: 64000 })),
	},
	{ additionalProperties: false },
);

const Ref = (prefix: "B" | "T") => Type.String({ pattern: `^${prefix}[1-9][0-9]*$`, maxLength: 20 });
const Version = Type.Integer({ minimum: 1 });
const Session = Type.String({ minLength: 1, maxLength: 128 });

/**
 * Typed edits to the epic → item → task hierarchy, posted to `WORKSPACE_ROUTES.backlogs` (the body is a command, not a
 * `BacklogMutation`). Every change to an existing record names the version the page read, so a stale page is refused
 * with the store's one-line error. The host applies them as the human and stays the authority for the depth rules and
 * for who may edit; the page only offers the controls.
 */
export const BacklogCommandSchema = Type.Union([
	/** A new step under an item (`item`) or a session (`session`); with neither, the host's own session owns it. */
	Type.Object(
		{
			command: Type.Literal("task.add"),
			goal: Type.String({ maxLength: 500 }),
			reason: Type.Optional(Type.String({ maxLength: 2000 })),
			item: Type.Optional(Ref("B")),
			session: Type.Optional(Session),
			state: Type.Optional(StringEnum(["todo", "ongoing"] as const)),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			command: Type.Literal("task.update"),
			task: Ref("T"),
			version: Version,
			goal: Type.Optional(Type.String({ maxLength: 500 })),
			reason: Type.Optional(Type.String({ maxLength: 2000 })),
			result: Type.Optional(Type.String({ maxLength: 2000 })),
			state: Type.Optional(StringEnum(TASK_STATES)),
		},
		{ additionalProperties: false },
	),
	/** `position` is 0-based among the owner's tasks. */
	Type.Object(
		{
			command: Type.Literal("task.move"),
			task: Ref("T"),
			version: Version,
			position: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	),
	/** Exactly one of `item` or `session` names the new owner; the host refuses both or neither. */
	Type.Object(
		{
			command: Type.Literal("task.reparent"),
			task: Ref("T"),
			version: Version,
			item: Type.Optional(Ref("B")),
			session: Type.Optional(Session),
		},
		{ additionalProperties: false },
	),
	/** An open session task becomes an item; the task moves under it. */
	Type.Object(
		{
			command: Type.Literal("task.promote"),
			task: Ref("T"),
			version: Version,
			title: Type.Optional(Type.String({ maxLength: 300 })),
			goal: Type.Optional(Type.String({ maxLength: 2000 })),
			why: Type.Optional(Type.String({ maxLength: 2000 })),
			type: Type.Optional(StringEnum(PROMOTED_TYPES)),
			parentId: Type.Optional(Ref("B")),
			priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
			state: Type.Optional(StringEnum(["backlog", "todo"] as const)),
		},
		{ additionalProperties: false },
	),
	/** Moves an item under an epic, or to the top level with `parentId: null`. */
	Type.Object(
		{
			command: Type.Literal("item.reparent"),
			id: Ref("B"),
			version: Version,
			parentId: Type.Union([Ref("B"), Type.Null()]),
		},
		{ additionalProperties: false },
	),
	/**
	 * Puts an item at a place in its column. `after` is the card that ends up directly above it, `before` the card directly
	 * below; the host ranks it between them (above `after` when only `before` is named). Name at least one.
	 */
	Type.Object(
		{
			command: Type.Literal("item.rank"),
			id: Ref("B"),
			version: Version,
			before: Type.Optional(Ref("B")),
			after: Type.Optional(Ref("B")),
		},
		{ additionalProperties: false },
	),
	/** A state change with no other edit; closing an item still needs its completion record, which the editor collects. */
	Type.Object(
		{
			command: Type.Literal("item.state"),
			id: Ref("B"),
			version: Version,
			state: StringEnum(STATES),
			/** Why: the store requires it to reopen a done or closed item. */
			note: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
		},
		{ additionalProperties: false },
	),
	/** Closes an item instead of deleting it: a kind, the reason in words and, for a duplicate, the original. */
	Type.Object(
		{
			command: Type.Literal("item.close"),
			id: Ref("B"),
			version: Version,
			kind: StringEnum(CLOSE_KINDS),
			text: Type.String({ minLength: 1, maxLength: 2000 }),
			of: Type.Optional(Ref("B")),
		},
		{ additionalProperties: false },
	),
]);

export type BacklogCommand = Static<typeof BacklogCommandSchema>;
