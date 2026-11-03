import { Type } from "typebox";
import { StringEnum } from "@octocodeai/octocode-ai";
import { type EntityInput, ITEM_TYPES } from "@octocodeai/octocode-contracts/backlogs";
import { parseRef } from "./item.ts";
import type { CompletionArgument } from "./completion-key.ts";

/** A link as the model may write it: `target` is a reference object or a shorthand string (`tool.ts` `linkInput`). */
export interface LinkArgument {
	relation: NonNullable<EntityInput["links"]>[number]["relation"];
	target: string | Record<string, unknown>;
}

/**
 * The entity fields as the model sees them. The store validates every field against the strict `EntityFieldsSchema`
 * (which names the failing path), so these declarations stay lean: nested inventories (a link target's per-resource
 * keys, a completion's file and verification rows) live in the field's description, not in property lists.
 */
const LinkField = Type.Unsafe<LinkArgument[]>({
	type: "array",
	description:
		"Replaces all the item's links. target: a repository path, URL or item id, or {resource: sessions|messages|reports|memories|artifacts, namespace, id}.",
	items: {
		type: "object",
		required: ["relation", "target"],
		properties: {
			relation: { type: "string", enum: ["related", "derived_from", "evidence", "output"] },
			target: { type: ["string", "object"] },
		},
	},
});

const completion = Type.Optional(
	Type.Unsafe<CompletionArgument>({
		type: "object",
		required: ["summary", "files", "verification"],
		properties: {
			summary: { type: "string" },
			files: { type: "array" },
			verification: { type: "object" },
			operationKey: { type: "string" },
		},
		description:
			"update with state done: the result. files: [{path, role: changed|reviewed|produced}]; verification: {status: passed|failed|not_run|not_applicable, summary}; optional operationKey (retry key); optional lesson (what to reuse) and replaces (a done item's completion to correct).",
	}),
);

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
				description: "add/update: prerequisite item IDs; [] clears. list: items needing any",
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
 * Links as stored: a string target is a URL (`external`), an item id (`B12`) or a repository-relative path, and a
 * backlogs or files target without `repositoryKey` is in this repository. The store validates the result.
 */
export function linkInput(links: readonly LinkArgument[], repo: string): EntityInput["links"] {
	return links.map(({ relation, target }) => {
		if (typeof target !== "string") {
			const local = (target.resource === "files" || target.resource === "backlogs") && !("repositoryKey" in target);
			return { relation, target: (local ? { ...target, repositoryKey: repo } : target) as never };
		}
		const text = target.trim();
		if (/^https?:\/\//i.test(text)) return { relation, target: { resource: "external", url: text } };
		if (/^[bB#]\d{1,9}$/.test(text))
			return { relation, target: { resource: "backlogs", repositoryKey: repo, id: `B${parseRef(text)}` } };
		return { relation, target: { resource: "files", repositoryKey: repo, path: text.replace(/^\.\//, "") } };
	});
}
