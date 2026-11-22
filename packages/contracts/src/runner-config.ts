import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/**
 * The External agents panel of the configuration page: the vendor CLIs (Claude Code, Codex, Cursor, Gemini, OpenCode)
 * that run `agent` tasks in their own harness. It mirrors `/providers` → External agents: what is installed, the
 * sign-in as the CLI's own status command last said, and whether tasks may use it. The host detects and writes; the
 * page shows and sends one verb. No credential is ever read or returned; signing in runs the vendor's own login in a
 * terminal (`login`). Rows name installed tools, so only the launch capability reads them
 * (`DAEMON_ROUTES.configRunners` is under `/api/admin/`).
 */

export const RUNNER_SIGN_IN_STATES = ["unchecked", "unknown", "signed-in", "signed-out"] as const;
export const RUNNER_BILLINGS = ["plan", "metered"] as const;

const Text = (maxLength: number) => Type.String({ maxLength });

/** A runner id the page can send back, such as `claude-code`. */
export const RunnerIdSchema = Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" });

export const RunnerRowSchema = Type.Object(
	{
		id: RunnerIdSchema,
		name: Text(80),
		cli: Type.Object(
			{
				command: Text(80),
				installed: Type.Boolean(),
				version: Type.Optional(Text(80)),
				/** The version whose commands were checked; an older `version` still runs. */
				tested: Text(40),
				untested: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		adapter: Type.Object(
			{
				command: Text(80),
				installed: Type.Boolean(),
				/** What installs it, shown when missing. */
				install: Text(200),
				/** The route a task takes when it is not the adapter (headless through the CLI). */
				route: Type.Optional(Text(120)),
			},
			{ additionalProperties: false },
		),
		signIn: Type.Object(
			{
				state: StringEnum(RUNNER_SIGN_IN_STATES),
				method: Type.Optional(Text(80)),
				billing: Type.Optional(StringEnum(RUNNER_BILLINGS)),
				error: Type.Optional(Text(300)),
				checkedAt: Type.Optional(Type.Number({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
		/** The vendor's own login command, to run in a terminal. */
		login: Text(200),
		/** Installed, signed in and runnable: a task can name it. */
		connected: Type.Boolean(),
		/** Tasks may start it: the external-agents setting is on and this CLI is selected. */
		enabled: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type RunnerRow = Static<typeof RunnerRowSchema>;

/** `GET /api/admin/config/runners`, and the reply to a command. */
export const RunnerListSchema = Type.Object(
	{
		/** The global `externalAgents` setting: off pauses every runner. */
		tasksEnabled: Type.Boolean(),
		runners: Type.Array(RunnerRowSchema, { maxItems: 32 }),
		/** What the last command did, in the words `/providers` prints. */
		message: Type.Optional(Text(300)),
	},
	{ additionalProperties: false },
);
export type RunnerList = Static<typeof RunnerListSchema>;

/**
 * `POST /api/admin/config/runners`: check one runner now (runs the vendor's own status command), enable or disable one
 * for tasks, or pause or resume all external agent tasks. Running sessions apply it after `/reload`. The reply is the
 * fresh `RunnerList`.
 */
export const RunnerCommandSchema = Type.Union([
	Type.Object({ action: Type.Literal("check"), id: RunnerIdSchema }, { additionalProperties: false }),
	Type.Object(
		{ action: Type.Literal("set-enabled"), id: RunnerIdSchema, enabled: Type.Boolean() },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("set-tasks"), enabled: Type.Boolean() }, { additionalProperties: false }),
]);
export type RunnerCommand = Static<typeof RunnerCommandSchema>;
