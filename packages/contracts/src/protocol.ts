import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";
import { CloseInputSchema, EntityFields, ITEM_TYPES } from "./backlogs.ts";
import { STATES } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { WorkspaceSnapshot } from "./workspace.ts";
import type { ProfileUpdate } from "./profiler.ts";

export const WORKSPACE_ROUTES = {
	application: "/api/application",
	assets: "/api/application/assets",
	history: "/api/application/history",
	backlogs: "/api/backlogs",
	workspace: "/api/workspace",
	audit: "/api/audit",
	reports: "/api/reports",
	live: "/api/backlogs/live",
	/** The profiler: agents at the route; requests, timeline, insights and trace export at `PROFILER_PATHS`. */
	profiler: "/api/profiler",
} as const;

/**
 * The user-level daemon's own routes. Scoped copies of the workspace routes live under `scope.session + "/<id>"` and
 * `scope.repo + "/<repoId>"` (for example `/s/<id>/api/application`); the page itself is `GET /` and takes the scope as
 * `?s=<id>` or `?r=<repoId>`. No route takes a filesystem path.
 */
export const DAEMON_ROUTES = {
	health: "/api/health",
	/** GET with any token: whether it may change the board (`{ writable }`); the page only hides controls by it, the daemon still refuses. */
	access: "/api/access",
	config: "/api/config",
	/** Launch capability only (under `/api/admin/`): POST one `ConfigSettingCommand`; the reply is the fresh `ConfigSnapshot`. */
	configSettings: "/api/admin/config/settings",
	/** Launch capability only: POST one `ConfigCredentialCommand` (the one request that carries a key); the reply is the fresh `ConfigSnapshot`. */
	configCredentials: "/api/admin/config/credentials",
	/** Launch capability only: POST one `ConfigProviderCommand` (provider or Pi source on/off); the reply is the fresh `ConfigSnapshot`. */
	configProviders: "/api/admin/config/providers",
	/** Launch capability only: POST one `SignInCommand` (start, status, answer, cancel of a host-run OAuth sign-in); the reply is a `SignInState`. */
	configSignin: "/api/admin/config/signin",
	/** Launch capability only: GET the `HarnessList` (`?repoId=`), POST one `HarnessSwitchCommand`; the reply is the fresh `HarnessList`. */
	configHarness: "/api/admin/config/harness",
	/** Launch capability only: GET the `HarnessPreview` of switching one harness on (`?id=&repoId=`); writes nothing. */
	configHarnessPreview: "/api/admin/config/harness/preview",
	/** Launch capability only: write-only new MCP definition; never starts or approves it. */
	configMcpAdd: "/api/admin/config/mcp/add",
	/** Launch capability only: GET the `ToolExposureList` (`?repoId=`), POST one `ToolPinCommand`; the reply is the fresh `ToolExposureList`. */
	configTools: "/api/admin/config/tools",
	/** Launch capability only: GET the `SecurityList` (`?repoId=`), POST one `SecurityActionCommand` (approve, deny, forget); the reply is the fresh `SecurityList`. */
	configSecurity: "/api/admin/config/security",
	sessions: "/api/sessions",
	repos: "/api/repos",
	drain: "/api/admin/drain",
	/** The daemon's remote publication (`/remote`): GET its status, POST to publish a link, DELETE to stop. */
	remote: "/api/admin/remote",
	scope: { session: "/s", repo: "/r" },
} as const;

/** Workspace report folders under `.octocode/agent/`, mapped to their report kind. */
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

export { BacklogCommandSchema, WorkspaceCommandSchema } from "./workspace-command.ts";
export type { BacklogCommand } from "./workspace-command.ts";

export const BacklogMutationSchema = Type.Object(
	{
		...EntityFields,
		type: Type.Optional(StringEnum(ITEM_TYPES)),
		op: StringEnum(["add", "update", "comment"] as const),
		close: Type.Optional(CloseInputSchema),
		id: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		goal: Type.Optional(Type.String()),
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
	| { type: "workspace"; data: WorkspaceSnapshot }
	| { type: "profiler"; data: ProfileUpdate };
