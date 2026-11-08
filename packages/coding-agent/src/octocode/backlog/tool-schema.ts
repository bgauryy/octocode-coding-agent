import { type TSchema, Type } from "typebox";
import { StringEnum, validateToolArguments } from "@octocodeai/octocode-ai";
import { type EntityInput, ITEM_TYPES } from "@octocodeai/octocode-contracts/backlogs";
import { STATES } from "@octocodeai/octocode-contracts/snapshot";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { BacklogError, parseRef } from "./item.ts";

/**
 * A link as the model may write it: `target` is a path, URL or item id (or, from older callers, a reference object);
 * `resource` names a session, message, report, memory or artifact. Exactly one is given (`linkInput`). A strict-mode
 * provider sends the unused one as null.
 */
export interface LinkArgument {
	relation: NonNullable<EntityInput["links"]>[number]["relation"];
	target?: string | Record<string, unknown> | null;
	resource?: Record<string, unknown> | null;
}

/**
 * The entity fields as the model sees them. Every nested shape is typed with closed objects, so the model sees the exact
 * keys and a provider's strict tool mode can constrain them. The store still validates each field against the strict
 * `EntityFieldsSchema` (which names the failing path).
 *
 * Three fields are accepted but not declared (`legacyEntityFields`): `links`, which older sessions and RPC callers send
 * (a path or URL in `evidence` becomes a link), `version` (an optimistic-lock check no recorded call ever needed; `get`
 * shows it), and the stored form of `completion`.
 */
const LegacyLinkField = Type.Unsafe<LinkArgument[]>({
	type: "array",
	items: {
		type: "object",
		required: ["relation"],
		properties: {
			relation: { type: "string", enum: ["related", "derived_from", "evidence", "output"] },
			// A path, URL or item id; older callers send a reference object.
			target: { type: ["string", "object", "null"] },
			resource: { type: ["object", "null"] },
		},
		additionalProperties: false,
	},
});

/**
 * What a call may carry beyond the declaration: `links`, and `completion` in either shape, which `completionInput`
 * checks so a missing key is named in plain words instead of a schema path.
 */
export const legacyEntityFields = {
	links: Type.Optional(LegacyLinkField),
	version: Type.Optional(Type.Integer()),
	completion: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object" })),
};

/** The completion as the model writes it: one sentence of verification and a list of paths (`completionInput` maps it to the stored shape). */
function completionField() {
	return Type.Optional(
		Type.Unsafe<Record<string, unknown>>({
			type: "object",
			required: ["summary", "verification"],
			properties: {
				summary: { type: "string" },
				verification: {
					type: "string",
					description: 'What ran and its result; start "not applicable" if nothing ran',
				},
				files: { type: "array", items: { type: "string" }, description: "Paths changed" },
				lesson: { type: "string", description: "Reuse next time" },
				replaces: { type: "integer", description: "Completion id to correct" },
			},
			additionalProperties: false,
			description: "update to done: the result",
		}),
	);
}

const completion = completionField();

/**
 * The fields one `updates` entry may carry: a single update's own (id, version, completion, close) plus every item field
 * (`ITEM_ENTRY_FIELDS`), so a row can set a parent, paths or dependsOn as a single update does.
 */
export const UPDATE_ENTRY_KEYS: readonly string[] = ["id", "version", "completion", "close"];

/**
 * `updates`: several single updates in one call, each with its own id and version. Entries are plain objects here, like
 * `items`: `checkedEntry` checks each against the single update's own schema, so the shapes are declared once.
 */
export function updatesField() {
	return Type.Optional(
		Type.Unsafe<Array<Record<string, unknown>>>({
			type: "array",
			items: { type: "object" },
			description:
				"update: several entries instead of id, each with update's fields (id, state, note, completion, …); a refused entry does not stop the rest",
		}),
	);
}

/**
 * Every field an `items` entry may carry: the single add's fields, so a per-item `type`, parent, links, origin or note
 * works as well as a default beside `items`. Update-only fields (`version`, `close`, `completion`) are refused.
 */
export const ITEM_ENTRY_FIELDS: readonly string[] = [
	"title",
	"goal",
	"why",
	"paths",
	"evidence",
	"plan",
	"state",
	"priority",
	"tags",
	"type",
	"parentId",
	"dependsOn",
	"links",
	"from",
	"note",
];

/** The states a subagent may set: claiming and closing items its coordinator holds. */
const SUBAGENT_STATES = ["ongoing", "done"] as const;

/** The `state` field: an epic's state is derived, so the full tool tells models to claim its items instead. */
export function stateField(subagent: boolean) {
	return Type.Optional(
		subagent
			? StringEnum(SUBAGENT_STATES, { description: "update: ongoing or done" })
			: StringEnum(STATES, {
					description:
						"add: initial (default backlog); update: new. An epic follows its items: claim those, then set it done",
				}),
	);
}

/**
 * `items`: several adds in one call; fields given beside `items` are defaults for every entry. Entries are plain objects
 * here, so the declaration stays small on every request: `checkedEntry` checks each against the single add's own schema.
 */
export function itemsField() {
	return Type.Optional(
		Type.Unsafe<Array<Record<string, unknown>>>({
			type: "array",
			items: { type: "object" },
			description: "add: several items, each with title and add's fields; fields beside items are defaults",
		}),
	);
}

/** One `items` or `updates` entry checked like a single call's arguments (names, types, enums), so a bad entry is refused on its own row. */
export function checkedEntry(
	parameters: TSchema,
	entry: Record<string, unknown>,
	op: "add" | "update",
): Record<string, unknown> {
	let checked: Record<string, unknown>;
	try {
		checked = validateToolArguments(
			{ name: "backlog", description: "", parameters },
			{
				type: "toolCall",
				id: op,
				name: "backlog",
				arguments: { ...entry, op, reason: op },
			},
		);
	} catch (error) {
		// One row per entry: the failing fields ("  - priority: expected one of …"), not the arguments echoed back.
		const issues = errorMessage(error)
			.split("\n")
			.filter((line) => line.startsWith("  - "))
			.map((line) => line.slice(4));
		throw new Error(issues.length > 0 ? issues.join("; ") : errorMessage(error), { cause: error });
	}
	const { reason: _reason, ...rest } = checked;
	return rest;
}

/**
 * A subagent changes item state, notes and completion (and `add` takes a type), so it sees only those
 * fields, plus `parentId` and `dependsOn` as list filters only: it cannot write hierarchy or dependencies, and the
 * store refuses them on add and update with an error naming them (`writes.ts`). The parameter type stays the full shape.
 */
export function entityFields(subagent: boolean) {
	const full = {
		type: Type.Optional(StringEnum(ITEM_TYPES, { description: "Default feature; epic groups work. list: only this" })),
		parentId: Type.Optional(
			Type.Union([Type.String(), Type.Null()], { description: "Parent epic ID; null clears. list: its items" }),
		),
		dependsOn: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"prerequisite item IDs, or in an items entry an earlier entry's exact title; [] clears. list: items needing any",
			}),
		),
		completion,
	};
	if (!subagent) return full;
	const { type, completion: done } = full;
	const listOnly = {
		parentId: Type.Optional(Type.String({ description: "list only: items under this epic" })),
		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "list only: items needing any of these" })),
	};
	return { type, ...listOnly, completion: done } as unknown as typeof full;
}

/**
 * Links as stored: a string `target` is a URL (`external`), an item id (`B12`) or a repository-relative path; an object
 * `target` (older callers) or `resource` is a reference, and a backlogs or files one without `repositoryKey` is in this
 * repository. Each link has exactly one of the two. The store validates the result.
 */
export function linkInput(links: readonly LinkArgument[], repo: string): EntityInput["links"] {
	return links.map(({ relation, target, resource }, index) => {
		const given = [target, resource].filter((value) => value !== undefined && value !== null);
		if (given.length !== 1)
			throw new BacklogError(
				`links[${index}] needs exactly one of target (a repository path, URL or item id) or resource (a session, message, report, memory or artifact); it has ${given.length === 0 ? "neither" : "both"}.`,
			);
		const ref = given[0];
		if (typeof ref !== "string") {
			const local = (ref.resource === "files" || ref.resource === "backlogs") && !("repositoryKey" in ref);
			return { relation, target: (local ? { ...ref, repositoryKey: repo } : ref) as never };
		}
		const text = ref.trim();
		if (/^https?:\/\//i.test(text)) return { relation, target: { resource: "external", url: text } };
		if (/^[bB#]\d{1,9}$/.test(text))
			return { relation, target: { resource: "backlogs", repositoryKey: repo, id: `B${parseRef(text)}` } };
		return { relation, target: { resource: "files", repositoryKey: repo, path: text.replace(/^\.\//, "") } };
	});
}
