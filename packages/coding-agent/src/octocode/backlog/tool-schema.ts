import { Type } from "typebox";
import { StringEnum } from "@octocodeai/octocode-ai";
import { type EntityInput, ITEM_TYPES } from "@octocodeai/octocode-contracts/backlogs";
import { BacklogError, parseRef } from "./item.ts";
import type { CompletionArgument } from "./completion-key.ts";

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
 * `EntityFieldsSchema` (which names the failing path). A link's `target` is a plain string because strict mode cannot
 * union a string with an object; `acceptTargetShorthand` also lets validation take an object target.
 */
const LinkField = Type.Unsafe<LinkArgument[]>({
	type: "array",
	description: "Replaces all the item's links. Give each link target or resource, not both.",
	items: {
		type: "object",
		required: ["relation"],
		properties: {
			relation: { type: "string", enum: ["related", "derived_from", "evidence", "output"] },
			target: { type: "string", description: "A repository path, URL or item id" },
			resource: {
				type: "object",
				description: "For a session, message, report, memory or artifact",
				required: ["resource", "namespace", "id"],
				properties: {
					resource: { type: "string", enum: ["sessions", "messages", "reports", "memories", "artifacts"] },
					namespace: { type: "string" },
					id: { type: "string" },
				},
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	},
});

const completion = Type.Optional(
	Type.Unsafe<CompletionArgument>({
		type: "object",
		required: ["summary", "files", "verification"],
		properties: {
			summary: { type: "string" },
			files: {
				type: "array",
				items: {
					type: "object",
					required: ["path", "role"],
					properties: {
						path: { type: "string", description: "Repository-relative, no `..`" },
						role: { type: "string", enum: ["changed", "reviewed", "produced"] },
					},
					additionalProperties: false,
				},
			},
			verification: {
				type: "object",
				required: ["status", "summary"],
				properties: {
					status: {
						type: "string",
						enum: ["passed", "failed", "not_run", "not_applicable"],
						description: "Close only on passed/not_applicable; else stay ongoing with a note.",
					},
					summary: { type: "string" },
				},
				additionalProperties: false,
			},
			lesson: { type: "string", description: "What to reuse next time" },
			operationKey: { type: "string", description: "Retry key; omit and one is derived from the content" },
			replaces: {
				type: "integer",
				description: "Id of the done item's completion to correct; omit for the latest",
			},
		},
		additionalProperties: false,
		description: "update with state done: the result.",
	}),
);

/**
 * The declared parameters with each link `target` also accepting a reference object, as older transcripts and SDK
 * callers write it (`linkInput` maps it). The model is shown the strict string form; this copy only validates the call.
 */
export function acceptTargetShorthand<T extends object>(parameters: T): T {
	const copy = structuredClone(parameters) as {
		properties?: { links?: { items?: { properties?: { target?: object } } } };
	};
	const properties = copy.properties?.links?.items?.properties;
	if (properties?.target) properties.target = { type: ["string", "object", "null"] };
	return copy as T;
}

/**
 * A subagent changes item state, notes and completion (and `add` takes a type and links), so it sees only those
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
				description: "prerequisite item IDs; [] clears. list: items needing any",
			}),
		),
		links: Type.Optional(LinkField),
		completion,
		version: Type.Optional(
			Type.Integer({
				description: "update: the version get showed; a changed item refuses the edit. Omit, never guess",
			}),
		),
	};
	if (!subagent) return full;
	const { type, links, completion: done, version } = full;
	const listOnly = {
		parentId: Type.Optional(Type.String({ description: "list only: items under this epic" })),
		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "list only: items needing any of these" })),
	};
	return { type, ...listOnly, links, completion: done, version } as unknown as typeof full;
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
