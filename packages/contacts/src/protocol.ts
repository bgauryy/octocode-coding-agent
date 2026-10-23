import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";
import { EntityFields } from "./backlogs.ts";
import { STATES } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";

export const WORKSPACE_ROUTES = { application: "/api/application", backlogs: "/api/backlogs", workspace: "/api/workspace", audit: "/api/audit", live: "/api/backlogs/live" } as const;

export const WorkspaceCommandSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), action: StringEnum(["message", "work", "delegate", "stop"] as const), backlogId: Type.Optional(Type.String()), version: Type.Optional(Type.Integer()), to: Type.Optional(Type.String()), text: Type.Optional(Type.String({ maxLength: 64000 })) }, { additionalProperties: false });

export const BacklogMutationSchema = Type.Object(
	{
		...EntityFields,
		op: StringEnum(["add", "update", "remove", "comment"] as const),
		id: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		goal: Type.Optional(Type.String()),
		body: Type.Optional(Type.String()),
		plan: Type.Optional(Type.String()),
		why: Type.Optional(Type.String()),
		paths: Type.Optional(Type.Array(Type.String())),
		evidence: Type.Optional(Type.Array(Type.String())),
		tags: Type.Optional(Type.Array(Type.String())),
		note: Type.Optional(Type.String()),
		state: Type.Optional(StringEnum(STATES)),
		priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
	},
	{ additionalProperties: false },
);

export type BacklogMutation = Static<typeof BacklogMutationSchema>;
export type WorkspaceServerEvent = { type: "snapshot"; data: Snapshot } | { type: "workspace"; data: WorkspaceSnapshot };
