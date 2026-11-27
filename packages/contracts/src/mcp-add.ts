import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

const common = {
	name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
	scope: StringEnum(["global", "workspace"]),
	repoId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
};
const strings = Type.Record(Type.String(), Type.String());

/** Launch-capability request only. Environment variables and headers are never returned in a read model. */
export const McpAddCommandSchema = Type.Union([
	Type.Object(
		{
			...common,
			transport: Type.Literal("stdio"),
			command: Type.String({ minLength: 1 }),
			args: Type.Optional(Type.Array(Type.String())),
			env: Type.Optional(strings),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...common, transport: Type.Literal("http"), url: Type.String({ minLength: 1 }), headers: Type.Optional(strings) },
		{ additionalProperties: false },
	),
]);
export type McpAddCommand = Static<typeof McpAddCommandSchema>;

export const McpAddResultSchema = Type.Object(
	{ saved: Type.Literal(true), message: Type.String(), warnings: Type.Optional(Type.Array(Type.String())) },
	{ additionalProperties: false },
);
export type McpAddResult = Static<typeof McpAddResultSchema>;

/** Availability only; never returns registry names, definitions or secrets. */
export const McpAddAvailabilitySchema = Type.Object(
	{ available: Type.Boolean(), message: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
export type McpAddAvailability = Static<typeof McpAddAvailabilitySchema>;
