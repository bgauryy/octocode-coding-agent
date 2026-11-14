import { type TSchema, Type } from "typebox";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { CloseInputSchema, type EntityInput } from "@octocodeai/octocode-contracts/backlogs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { BacklogError, parseRef } from "./item.ts";

/**
 * The `close` parameter, rebuilt as a plain object: spreading the contract schema into `Type.Optional` leaked its
 * `~optional` marker into the declaration.
 */
export const closeField = Type.Object(CloseInputSchema.properties, {
	additionalProperties: false,
});

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
 * Every nested shape the model sees is typed with closed objects, so it sees the exact keys and a provider's strict
 * tool mode can constrain them. The store still validates each field against the strict `EntityFieldsSchema` (which
 * names the failing path).
 *
 * Accepted beyond the declaration (`legacyEntityFields`): `version` (an optimistic-lock check no recorded call ever
 * needed; `get` shows it), the stored form of `completion`, and the older forms of a link (a reference object as
 * `target`, a null for the unused one of `target` and `resource`).
 */

/** The link relations and the resources a link may name besides a path, URL or item. */
const LINK_RELATIONS = ["related", "derived_from", "evidence", "output"];
const LINK_RESOURCES = ["sessions", "messages", "reports", "memories", "artifacts"];

/**
 * `links` as a `backlogPlan` entry declares it: `target` is a path, URL or item id, `resource` a stored record. A
 * plain schema object, like the other entry fields (`plan-schema.ts`).
 */
export const linksField = {
	type: "array",
	items: {
		type: "object",
		required: ["relation"],
		properties: {
			relation: { type: "string", enum: LINK_RELATIONS },
			target: { type: "string", description: "repository path, URL or item id" },
			resource: {
				type: "object",
				required: ["resource", "namespace", "id"],
				properties: {
					resource: { type: "string", enum: LINK_RESOURCES },
					namespace: { type: "string" },
					id: { type: "string" },
				},
				additionalProperties: false,
				description: "instead of target: a stored record",
			},
		},
		additionalProperties: false,
	},
	description: "references; replaces the current ones",
};

const LegacyLinkField = Type.Unsafe<LinkArgument[]>({
	type: "array",
	items: {
		type: "object",
		required: ["relation"],
		properties: {
			relation: { type: "string", enum: LINK_RELATIONS },
			// A path, URL or item id; older callers send a reference object.
			target: { type: ["string", "object", "null"] },
			resource: { type: ["object", "null"] },
		},
		additionalProperties: false,
	},
});

/**
 * What a call may carry beyond the declaration: `links` in either form, `version`, and `completion` in either shape,
 * which `completionInput` checks so a missing key is named in plain words instead of a schema path.
 */
export const legacyEntityFields = {
	links: Type.Optional(LegacyLinkField),
	version: Type.Optional(Type.Integer()),
	completion: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object" })),
};

/** The completion as the model writes it: one sentence of verification and a list of paths (`completionInput` maps it to the stored shape). */
export function completionField(description: string) {
	return Type.Optional(
		Type.Unsafe<Record<string, unknown>>({
			type: "object",
			required: ["summary", "verification"],
			properties: {
				summary: { type: "string" },
				verification: {
					type: "string",
					description: "Start passed, failed, not run or not applicable; name the check",
				},
				files: { type: "array", items: { type: "string" } },
				lesson: { type: "string" },
				replaces: { type: "integer", description: "Completion id to correct" },
				operationKey: { type: "string", description: "Retry key; repeats record once" },
			},
			additionalProperties: false,
			description,
		}),
	);
}

/** One `items` entry checked as a call's arguments are (names, types, enums) against `schema`, so a bad entry is refused on its own row. */
export function checkedEntry(schema: TSchema, entry: Record<string, unknown>): Record<string, unknown> {
	let checked: Record<string, unknown>;
	try {
		checked = validateToolArguments(
			{ name: "backlogPlan", description: "", parameters: schema },
			{ type: "toolCall", id: "items", name: "backlogPlan", arguments: entry as never },
		);
	} catch (error) {
		// One row per entry: the failing fields ("  - priority: expected one of …"), not the arguments echoed back.
		const issues = errorMessage(error)
			.split("\n")
			.filter((line) => line.startsWith("  - "))
			.map((line) => line.slice(4));
		throw new Error(issues.length > 0 ? issues.join("; ") : errorMessage(error), { cause: error });
	}
	return checked;
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
