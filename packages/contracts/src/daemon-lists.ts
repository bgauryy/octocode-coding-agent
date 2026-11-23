import { Type, type Static } from "typebox";
import { ActivitySchema } from "./activity-light.ts";

const Text = (maxLength = 256) => Type.String({ minLength: 1, maxLength });

/** A session the daemon lists: live and attachable, or recently seen. `repoId` names its repository in routes. */
export const DaemonSessionSchema = Type.Object(
	{
		id: Text(),
		repoId: Text(64),
		repoName: Type.String({ maxLength: 256 }),
		cwd: Type.String({ maxLength: 4096 }),
		startedAt: Type.Number(),
		/** The daemon holds an authenticated attach connection to it right now. */
		attached: Type.Boolean(),
		/** A run is in progress (absent when the daemon has not seen the session's state yet). */
		busy: Type.Optional(Type.Boolean()),
		/** The run is blocked on a dialog: its title, so a list can show what is being asked. Absent when nothing waits. */
		needsYou: Type.Optional(Type.String({ maxLength: 300 })),
		/**
		 * The session's light, from the same `activity` mapping the terminal footer and the web header read (failed,
		 * compacting, retrying included). Absent until the daemon has seen the session's state, and from an older daemon.
		 */
		activity: Type.Optional(ActivitySchema),
	},
	{ additionalProperties: false },
);
/** A live session the daemon could not attach, with the reason to show (for example "restart this session"). */
export const DaemonUnavailableSessionSchema = Type.Object(
	{
		id: Text(),
		repoName: Type.String({ maxLength: 256 }),
		cwd: Type.String({ maxLength: 4096 }),
		message: Type.String({ maxLength: 300 }),
	},
	{ additionalProperties: false },
);
/** At most 200 sessions; `truncated` says more exist. */
export const DaemonSessionsSchema = Type.Object(
	{
		sessions: Type.Array(DaemonSessionSchema, { maxItems: 200 }),
		unavailable: Type.Optional(Type.Array(DaemonUnavailableSessionSchema, { maxItems: 50 })),
		truncated: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

/** A workspace in the persistent catalog or a live session. Its UUID also identifies its web routes. */
export const DaemonRepoSchema = Type.Object(
	{
		id: Text(64),
		name: Type.String({ maxLength: 256 }),
		sessions: Type.Integer({ minimum: 0 }),
		hasReports: Type.Boolean(),
	},
	{ additionalProperties: false },
);
/** At most 200 repositories; `truncated` says more exist. */
export const DaemonReposSchema = Type.Object(
	{ repos: Type.Array(DaemonRepoSchema, { maxItems: 200 }), truncated: Type.Optional(Type.Boolean()) },
	{ additionalProperties: false },
);

export type DaemonSession = Static<typeof DaemonSessionSchema>;
export type DaemonUnavailableSession = Static<typeof DaemonUnavailableSessionSchema>;
export type DaemonSessions = Static<typeof DaemonSessionsSchema>;
export type DaemonRepo = Static<typeof DaemonRepoSchema>;
export type DaemonRepos = Static<typeof DaemonReposSchema>;
