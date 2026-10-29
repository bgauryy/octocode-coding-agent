import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";
import { EntityFields } from "./backlogs.ts";
import { STATES } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";

export const WORKSPACE_ROUTES = {
	application: "/api/application",
	assets: "/api/application/assets",
	history: "/api/application/history",
	backlogs: "/api/backlogs",
	workspace: "/api/workspace",
	audit: "/api/audit",
	reports: "/api/reports",
	live: "/api/backlogs/live",
} as const;

/**
 * The user-level daemon's own routes. Scoped copies of the workspace routes live under `scope.session + "/<id>"` and
 * `scope.repo + "/<repoId>"` (for example `/s/<id>/api/application`); the page itself is `GET /` and takes the scope as
 * `?s=<id>` or `?r=<repoId>`. No route takes a filesystem path.
 */
export const DAEMON_ROUTES = {
	health: "/api/health",
	config: "/api/config",
	sessions: "/api/sessions",
	repos: "/api/repos",
	drain: "/api/admin/drain",
	scope: { session: "/s", repo: "/r" },
} as const;

/** Workspace report folders under `.octocode/`, mapped to their report kind. */
export const REPORT_SOURCE_DIRS = {
	"octocode-rfc-generator": "rfc",
	"octocode-research": "research",
	"octocode-brainstorming": "brainstorm",
} as const;
export const REPORT_KINDS = ["rfc", "research", "brainstorm"] as const;

export const ReportFileSummarySchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128 }),
		bytes: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

/** One saved report folder: its id is the folder name, its files are the Markdown documents inside it. */
export const ReportSummarySchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		kind: StringEnum(REPORT_KINDS),
		title: Type.String({ maxLength: 300 }),
		status: Type.Optional(Type.String({ maxLength: 40 })),
		confidence: Type.Optional(Type.String({ maxLength: 20 })),
		question: Type.Optional(Type.String({ maxLength: 2000 })),
		updated: Type.String({ minLength: 4, maxLength: 64 }),
		files: Type.Array(ReportFileSummarySchema, { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

export const ReportsIndexSchema = Type.Object(
	{ reports: Type.Array(ReportSummarySchema, { maxItems: 200 }) },
	{ additionalProperties: false },
);

/** One Markdown file of a report; the host only serves files listed in the report's own index entry. */
export const ReportFileSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		kind: StringEnum(REPORT_KINDS),
		file: Type.String({ minLength: 1, maxLength: 128 }),
		markdown: Type.String({ maxLength: 524288 }),
	},
	{ additionalProperties: false },
);

export const WorkspaceCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		action: StringEnum(["message", "work", "delegate", "stop"] as const),
		backlogId: Type.Optional(Type.String()),
		version: Type.Optional(Type.Integer()),
		to: Type.Optional(Type.String()),
		text: Type.Optional(Type.String({ maxLength: 64000 })),
	},
	{ additionalProperties: false },
);

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
export type ReportFileSummary = Static<typeof ReportFileSummarySchema>;
export type ReportSummary = Static<typeof ReportSummarySchema>;
export type ReportsIndex = Static<typeof ReportsIndexSchema>;
export type ReportFile = Static<typeof ReportFileSchema>;
export type WorkspaceServerEvent =
	| { type: "snapshot"; data: Snapshot }
	| { type: "workspace"; data: WorkspaceSnapshot };
