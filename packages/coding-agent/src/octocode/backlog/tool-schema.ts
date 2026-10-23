import { Type } from "typebox";
import { EntityFields, type EntityInput } from "./model.ts";

/**
 * The entity fields as the model sees them. The store validates every field against the strict `EntityFieldsSchema`
 * (which names the failing path), so these declarations stay short: a link target is one flat object instead of four
 * variants, and nested objects drop `additionalProperties: false`.
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
					repositoryKey: { type: "string" },
					id: { type: "string" },
					path: { type: "string" },
					revision: { type: "string" },
					namespace: { type: "string" },
					url: { type: "string" },
				},
			},
		},
	},
});

/** Remove `additionalProperties: false` from a JSON schema, recursively. */
function open<T>(schema: T): T {
	if (Array.isArray(schema)) return schema.map(open) as T;
	if (typeof schema !== "object" || schema === null) return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key, value]) => !(key === "additionalProperties" && value === false))
			.map(([key, value]) => [key, open(value)]),
	) as T;
}

const completion = Type.Optional(
	Type.Unsafe<NonNullable<EntityInput["completion"]>>({
		...open(EntityFields.completion),
		description: "Done result; operationKey deduplicates retries; replaces corrects history.",
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
