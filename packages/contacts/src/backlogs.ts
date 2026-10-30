import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

export const ITEM_TYPES = ["epic", "task", "bug", "research"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
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
	type: Type.Optional(StringEnum(ITEM_TYPES, { description: "Default task; epic groups work." })),
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
