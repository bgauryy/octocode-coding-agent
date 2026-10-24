import { Type } from "typebox";
import { EntityFields, type EntityInput } from "@octocodeai/octocode-contacts/backlogs";

/**
 * The entity fields as the model sees them. The store validates every field against the strict `EntityFieldsSchema`
 * (which names the failing path), so these declarations stay lean: a link target is one flat object instead of four
 * variants, and nested inventories (a link target's per-resource keys, a completion's file and verification rows) live
 * in the field's description, not in property lists.
 */
const LinkField = Type.Unsafe<NonNullable<EntityInput["links"]>>({
	type: "array",
	description:
		"Replace links. target by resource: backlogs {repositoryKey, id}; files {repositoryKey, path, revision?}; sessions|messages|reports|memories|artifacts {namespace, id}; external {url}.",
	items: {
		type: "object",
		required: ["relation", "target"],
		properties: {
			relation: { type: "string", enum: ["related", "derived_from", "evidence", "output"] },
			target: {
				type: "object",
				required: ["resource"],
				properties: {
					resource: {
						type: "string",
						enum: ["backlogs", "files", "sessions", "messages", "reports", "memories", "artifacts", "external"],
					},
				},
			},
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
			"Done result. files: [{path, role: changed|reviewed|produced, repositoryKey?, revision?}]; verification: {status: passed|failed|not_run|not_applicable, summary}; operationKey deduplicates retries; replaces corrects history.",
	}),
);

/**
 * A subagent changes item state, notes and completion (and `add` takes a type), so it sees only those fields. The
 * parameter type stays the full shape: the tool refuses the omitted fields with an error naming them.
 */
export function entityFields(subagent: boolean) {
	const full = {
		type: EntityFields.type,
		reason: EntityFields.reason,
		parentId: EntityFields.parentId,
		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Prerequisite IDs; [] clears." })),
		links: Type.Optional(LinkField),
		completion,
		version: EntityFields.version,
	};
	if (!subagent) return full;
	const { type, completion: done, version } = full;
	return { type, completion: done, version } as unknown as typeof full;
}

/** The fields a subagent proposal cannot set: hierarchy, dependencies and links belong to the parent. */
export const SUBAGENT_REFUSED_ADD = ["parentId", "dependsOn", "links", "reason"] as const;
