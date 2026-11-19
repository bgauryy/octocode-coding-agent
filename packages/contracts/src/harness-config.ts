import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/**
 * The Harness panel of the configuration page: the switches `/harness` and `/configuration` show, one row per harness,
 * MCP server, skill, hook, plugin and extension. Rows carry ids that may hold file paths, so only the launch capability
 * reads them (`DAEMON_ROUTES.configHarness` is under `/api/admin/`).
 */

/** The `/configuration` id kinds the panel lists, in display order. */
export const HARNESS_ROW_KINDS = [
	"harness",
	"mcp",
	"skill",
	"hooks",
	"hook",
	"plugin",
	"installed",
	"extension",
] as const;
export const HarnessRowKindSchema = StringEnum(HARNESS_ROW_KINDS);
export type HarnessRowKind = Static<typeof HarnessRowKindSchema>;

/** Which file decides a row: the workspace's settings, the global ones, or nothing (the built-in default). */
export const HARNESS_SET_BY = ["workspace", "global", "default"] as const;

/** When a switch takes effect in a running session. */
export const HARNESS_APPLIES_WHEN = ["now", "reload", "next-session"] as const;

/** A switch id the page can send back: no control characters, bounded. */
export const HarnessIdSchema = Type.String({ minLength: 1, maxLength: 2048, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });

export const HarnessRowSchema = Type.Object(
	{
		/** The `/configuration` id (`harness:claude`, `mcp:docs`, `skill:<path>`). */
		id: HarnessIdSchema,
		kind: HarnessRowKindSchema,
		label: Type.String({ maxLength: 512 }),
		/** Group, state and where it is defined, as `/harness` shows it. */
		detail: Type.Optional(Type.String({ maxLength: 1024 })),
		on: Type.Boolean(),
		setBy: StringEnum(HARNESS_SET_BY),
		/** Why the row cannot be switched (an always-on built-in). */
		locked: Type.Optional(Type.String({ maxLength: 512 })),
		appliesWhen: StringEnum(HARNESS_APPLIES_WHEN),
	},
	{ additionalProperties: false },
);
export type HarnessRow = Static<typeof HarnessRowSchema>;

/** `GET /api/admin/config/harness[?repoId=]`, and the reply to a switch. */
export const HarnessListSchema = Type.Object(
	{
		rows: Type.Array(HarnessRowSchema, { maxItems: 5000 }),
		/** Present when a workspace was chosen: whether its own switches apply (a trusted folder). */
		workspace: Type.Optional(Type.Object({ trusted: Type.Boolean() }, { additionalProperties: false })),
		/** What the last switch did, in the words `/configuration` prints. */
		message: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);
export type HarnessList = Static<typeof HarnessListSchema>;

/**
 * `POST /api/admin/config/harness`: switch one row on or off in the global settings, or in the chosen workspace's
 * (`repoId`, never a path; the folder must be trusted). The reply is the fresh `HarnessList`.
 */
export const HarnessSwitchCommandSchema = Type.Object(
	{
		id: HarnessIdSchema,
		on: Type.Boolean(),
		scope: StringEnum(["global", "workspace"] as const),
		repoId: Type.Optional(Type.String({ pattern: "^[\\w.-]{1,128}$" })),
	},
	{ additionalProperties: false },
);
export type HarnessSwitchCommand = Static<typeof HarnessSwitchCommandSchema>;

/**
 * `GET /api/admin/config/harness/preview?id=&repoId=`: what switching a harness source on would bring, scanned now
 * by the host (the static scan `/harness` shows before a switch). Nothing is started or saved. `lines` is the host's
 * rendered text, worst item first; it is empty when the row has no source to scan (the switch then needs no preview).
 */
export const HarnessPreviewSchema = Type.Object(
	{
		id: HarnessIdSchema,
		label: Type.String({ maxLength: 512 }),
		/** Items the scan found (skills, MCP servers, hooks); 0 for an empty scan. */
		items: Type.Integer({ minimum: 0 }),
		lines: Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 64 }),
	},
	{ additionalProperties: false },
);
export type HarnessPreview = Static<typeof HarnessPreviewSchema>;
