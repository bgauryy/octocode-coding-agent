import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/**
 * The Security panel of the configuration page: every hook, MCP server and skill the guard reviewed, with its state,
 * rating, findings and, when its approved content changed, the lines that changed. It mirrors `/security`; the host
 * renders every text (the page never judges or scans). Items carry file paths, so only the launch capability reads
 * them (`DAEMON_ROUTES.configSecurity` is under `/api/admin/`).
 */

export const SECURITY_KINDS = ["hook", "mcp", "skill"] as const;
export const SECURITY_RATINGS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const SECURITY_STATES = ["not checked", "approved", "denied"] as const;
export const SECURITY_ACTIONS = ["approve", "deny", "forget"] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

/** An item id the page can send back: no control characters, bounded. */
export const SecurityItemIdSchema = Type.String({
	minLength: 1,
	maxLength: 2048,
	pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

export const SecurityFindingSchema = Type.Object(
	{
		rule: Type.String({ maxLength: 128 }),
		rating: StringEnum(SECURITY_RATINGS),
		text: Type.String({ maxLength: 2048 }),
	},
	{ additionalProperties: false },
);

export const SecurityItemSchema = Type.Object(
	{
		/** The `/security` id (`mcp:<name>`, `skill:<path>`, `hook:<digest>`), sent back by an action. */
		id: SecurityItemIdSchema,
		kind: StringEnum(SECURITY_KINDS),
		label: Type.String({ maxLength: 512 }),
		/** Where it is defined. */
		path: Type.String({ maxLength: 2048 }),
		/** `global` (your files) or `workspace` (this repository). */
		scope: StringEnum(["global", "workspace"] as const),
		state: StringEnum(SECURITY_STATES),
		rating: StringEnum(SECURITY_RATINGS),
		/** The approved content changed since the approval. */
		changed: Type.Boolean(),
		/** Off in a session because the guard enforces its kind and the item is not approved. */
		withheld: Type.Boolean(),
		/** Set when the item could not be read in full: it cannot be approved. */
		unreadable: Type.Optional(Type.String({ maxLength: 1024 })),
		/** What approval grants, most important first. */
		grants: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 }),
		findings: Type.Array(SecurityFindingSchema, { maxItems: 200 }),
		/** The "Changed since you approved it" lines (`+` added, `-` removed); present only when `changed`. */
		changes: Type.Optional(Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 130 })),
	},
	{ additionalProperties: false },
);
export type SecurityItem = Static<typeof SecurityItemSchema>;

/** `GET /api/admin/config/security[?repoId=]`, and the reply to an action. */
export const SecurityListSchema = Type.Object(
	{
		items: Type.Array(SecurityItemSchema, { maxItems: 5000 }),
		/** Whether the workspace is trusted; an untrusted one lists only your own files' items. */
		workspace: Type.Optional(Type.Object({ trusted: Type.Boolean() }, { additionalProperties: false })),
		/** What the last action did, in the words `/security` prints. */
		message: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);
export type SecurityList = Static<typeof SecurityListSchema>;

/**
 * `POST /api/admin/config/security`: approve, deny or forget one item at the content the list showed. The host records
 * the decision through the guard, as `/security` does. The reply is the fresh `SecurityList`.
 */
export const SecurityActionCommandSchema = Type.Object(
	{
		id: SecurityItemIdSchema,
		action: StringEnum(SECURITY_ACTIONS),
		repoId: Type.Optional(Type.String({ pattern: "^[\\w.-]{1,128}$" })),
	},
	{ additionalProperties: false },
);
export type SecurityActionCommand = Static<typeof SecurityActionCommandSchema>;
