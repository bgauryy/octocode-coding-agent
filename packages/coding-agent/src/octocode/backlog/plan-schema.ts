import { StringEnum } from "@octocodeai/octocode-ai";
import { ITEM_TYPES } from "@octocodeai/octocode-contracts/backlogs";
import { STATES } from "@octocodeai/octocode-contracts/snapshot";
import { type TSchema, Type } from "typebox";
import { PRIORITIES } from "./store.ts";
import { legacyEntityFields, linksField } from "./tool-schema.ts";
import { legacyListFields, listFields } from "./tool-list.ts";

/** The states `add` and `edit` set. `done` takes a completion, which is `backlog`'s `done`. */
const PLAN_STATES = ["backlog", "todo", "ongoing"] as const;

const text = (description: string) => ({ type: "string", description });
const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

/**
 * The fields of one item as `add` and `edit` write them. They exist only inside an `items` entry, so each has one
 * meaning and `list` filters by fields of its own (`listFields`). Plain schema objects: `Type.Optional` inside a
 * nested object leaks its `~optional` marker into the declaration.
 */
const ITEM = {
	id: text("edit: the item"),
	version: { type: "integer", description: "edit: refused if stale" },
	title: text("one-line summary"),
	goal: text("checkable Definition of Done; add needs it"),
	why: text("why it matters; add needs it"),
	type: { type: "string", enum: [...ITEM_TYPES], description: "default feature; epic groups work" },
	parentId: {
		anyOf: [{ type: "string" }, { type: "null" }],
		description: "epic id or an earlier entry's title; null clears",
	},
	dependsOn: list("prerequisite ids or earlier entries' titles; [] clears"),
	paths: list("affected files, dirs, components"),
	evidence: list("observations with source (path:line, command)"),
	plan: text("approach, steps, blast radius"),
	priority: { type: "string", enum: [...PRIORITIES], description: "p0 urgent … p3 someday (default p2)" },
	tags: { type: "array", items: { type: "string" } },
	from: text('origin item id; "" clears'),
	links: linksField,
	state: {
		type: "string",
		enum: [...PLAN_STATES],
		description: "default backlog; an epic follows its items",
	},
	note: text("appended note; a reopen needs one"),
};

/** The item fields by name, for a call that writes one beside `items` or sends one as a list filter. */
export const ITEM_FIELDS: readonly string[] = Object.keys(ITEM);
/** The fields an entry may carry by operation: an `add` entry has no `id` or `version`. */
export const ADD_ENTRY_FIELDS: readonly string[] = ITEM_FIELDS.filter((key) => key !== "id" && key !== "version");
export const EDIT_ENTRY_FIELDS: readonly string[] = ["id", "version", ...ADD_ENTRY_FIELDS];
/** Fields `backlog` owns, with the operation that takes each: an entry that sends one is told where it goes. */
export const WORK_FIELDS: Record<string, string> = { completion: "done", close: "close" };

export const PLAN_OPS = ["add", "edit", "list", "stat"] as const;

/**
 * The declaration of `backlogPlan`: `add` and `edit` write the entries of `items`, each typed, so the model has a
 * contract for every item and a provider's strict tool mode can constrain it; every other field is a `list` or `stat` filter.
 */
export function planParameters(ops: string) {
	return Type.Object(
		{
			op: StringEnum(PLAN_OPS, { description: ops }),
			items: Type.Optional(
				Type.Array(
					Type.Unsafe<Record<string, unknown>>({ type: "object", properties: ITEM, additionalProperties: false }),
					{ description: "a refused one does not stop the rest" },
				),
			),
			...listFields,
		},
		{ additionalProperties: false },
	);
}

/**
 * What a call may carry beyond the declaration: the undeclared list filters, and any other field, which the tool
 * answers by name (an item field written beside `items` belongs in an entry). Entries are plain objects here: each is
 * checked on its own against `entryAccepted`, so a bad one is refused on its row and the rest still run.
 */
export function planAccepted(parameters: ReturnType<typeof planParameters>) {
	return Type.Object(
		{
			...parameters.properties,
			items: Type.Optional(Type.Unsafe<Array<Record<string, unknown>>>({ type: "array", items: { type: "object" } })),
			...legacyListFields,
		},
		{ additionalProperties: true },
	);
}

/**
 * What one entry may carry: the declared fields, the older link forms (`legacyEntityFields`), a `state`
 * of done and the fields of finishing and closing, which the tool refuses with the `backlog` operation to use.
 */
export const entryAccepted = Type.Object(
	{
		...Object.fromEntries(
			Object.entries(ITEM).map(([key, schema]): [string, TSchema] => [key, Type.Optional(Type.Unsafe(schema))]),
		),
		state: Type.Optional(StringEnum(STATES)),
		// Any text: the tool names the item types in its own refusal.
		type: Type.Optional(Type.String()),
		links: legacyEntityFields.links,
		version: legacyEntityFields.version,
		completion: Type.Optional(Type.Unsafe<unknown>({})),
		close: Type.Optional(Type.Unsafe<unknown>({})),
	},
	{ additionalProperties: false },
);
