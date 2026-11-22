import { Type, type Static } from "typebox";

/** `GET /api/access`: the actions available to this browser link. */
export const DaemonAccessSchema = Type.Object(
	{ writable: Type.Boolean(), terminalCommands: Type.Optional(Type.Boolean()) },
	{ additionalProperties: false },
);
export type DaemonAccess = Static<typeof DaemonAccessSchema>;
