import { Type } from "typebox";
import { EntityFields, type EntityInput } from "@octocodeai/octocode-contacts/backlogs";
import { parseRef } from "./item.ts";

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
		'References (docs, reports, URLs, items); replaces all. target: a repository path, URL or item id, e.g. [{relation: "output", target: ".octocode/x/report.md"}], or {resource: sessions|messages|reports|memories|artifacts, namespace, id}.',
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
	Type.Unsafe<NonNullable<EntityInput["completion"]>>({
		type: "object",
		required: ["summary", "files", "verification", "operationKey"],
		properties: {
			summary: { type: "string" },
			files: { type: "array" },
			verification: { type: "object" },
			lesson: { type: "string" },
			operationKey: { type: "string" },
			replaces: { type: "number" },
		},
		description:
			"Done result. files: [{path, role: changed|reviewed|produced, repositoryKey?, revision?}]; verification: {status: passed|failed|not_run|not_applicable, summary}; lesson: what to reuse next time; operationKey: unique per completion; replaces: optional, a done item's new completion replaces the latest.",
	}),
);

/**
 * A subagent changes item state, notes and completion (and `add` takes a type and links), so it sees only those
 * fields. The parameter type stays the full shape: the tool refuses the omitted fields with an error naming them.
 */
export function entityFields(subagent: boolean) {
	const full = {
		type: EntityFields.type,
		parentId: EntityFields.parentId,
		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Prerequisite IDs; [] clears." })),
		links: Type.Optional(LinkField),
		completion,
		version: Type.Optional(
			Type.Integer({
				description: "Optional: the version get showed; a changed item refuses the edit. Omit, never guess.",
			}),
		),
	};
	if (!subagent) return full;
	const { type, links, completion: done, version } = full;
	return { type, links, completion: done, version } as unknown as typeof full;
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
