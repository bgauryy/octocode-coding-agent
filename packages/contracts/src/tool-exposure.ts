import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/**
 * The Tools panel of the configuration page: how much of each tool a session declares to the model, and the pin that
 * fixes it. `direct` is the full description and schema, `deferred` the description with thin parameters until the
 * tool is used, `hidden` not declared at all. Rows name configured servers, so only the launch capability reads them
 * (`DAEMON_ROUTES.configTools` is under `/api/admin/`).
 */

export const TOOL_EXPOSURE_STATES = ["direct", "deferred", "hidden"] as const;
export const ToolExposureStateSchema = StringEnum(TOOL_EXPOSURE_STATES);
export type ToolExposureState = Static<typeof ToolExposureStateSchema>;

/** The native tools a pin can defer; every other native tool is always declared in full. */
export const NATIVE_PINNABLE_TOOLS = ["web", "archive", "models", "backlogPlan"] as const;

/**
 * What decided a tool's state: its own pin, a `toolExposure` pattern, its server's `exposure`, use in the last 24 hours
 * (`mcpExposure: "recent"`), another value of that setting, nothing (`default`), or `core` for a native tool that is
 * never deferred.
 */
export const TOOL_DECIDED_BY = ["pin", "pattern", "server", "recent", "setting", "default", "core"] as const;

/** A server or tool name the page can send back: no control characters, bounded. */
const ToolNameSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });

export const ToolExposureRowSchema = Type.Object(
	{
		name: ToolNameSchema,
		/** The pin saved for this tool, in the configuration a new session reads. */
		pin: Type.Optional(ToolExposureStateSchema),
		/** What the running session declares when the list is `live`; otherwise what the configuration says. */
		state: ToolExposureStateSchema,
		decidedBy: StringEnum(TOOL_DECIDED_BY),
	},
	{ additionalProperties: false },
);
export type ToolExposureRow = Static<typeof ToolExposureRowSchema>;

export const ToolExposureGroupSchema = Type.Object(
	{
		kind: StringEnum(["native", "mcp"] as const),
		/** The MCP server's configured name; `native` for the native tools. */
		name: ToolNameSchema,
		tools: Type.Array(ToolExposureRowSchema, { maxItems: 2000 }),
		/** False when no pin can be saved for the group (a server an extension registered). */
		pinnable: Type.Boolean(),
		/** Why the group lists no tools or only some, in fixed words. */
		note: Type.Optional(Type.String({ maxLength: 300 })),
	},
	{ additionalProperties: false },
);
export type ToolExposureGroup = Static<typeof ToolExposureGroupSchema>;

/** `GET /api/admin/config/tools[?repoId=]`, and the reply to a pin. */
export const ToolExposureListSchema = Type.Object(
	{
		/** The `mcpExposure` setting that decides tools without a pin. */
		setting: Type.String({ minLength: 1, maxLength: 64 }),
		/** True when a running session answered: `state` is what that session declares. */
		live: Type.Boolean(),
		groups: Type.Array(ToolExposureGroupSchema, { maxItems: 500 }),
		/** Present when a workspace was chosen: whether its own files apply (a trusted folder). */
		workspace: Type.Optional(Type.Object({ trusted: Type.Boolean() }, { additionalProperties: false })),
		/** What the last pin did. */
		message: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);
export type ToolExposureList = Static<typeof ToolExposureListSchema>;

const PinTargetProperties = {
	scope: StringEnum(["global", "workspace"] as const),
	repoId: Type.Optional(Type.String({ pattern: "^[\\w.-]{1,128}$" })),
};

/**
 * `POST /api/admin/config/tools`: pin one tool, or remove its pin with `pin: null`, in the global configuration or the
 * chosen workspace's (`repoId`, never a path; the folder must be trusted). An MCP pin names one tool exactly: `*` is
 * refused, so the page cannot write a pattern. The reply is the fresh `ToolExposureList`. Sessions that are running keep
 * what they declared.
 */
export const ToolPinCommandSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("mcp"),
			server: ToolNameSchema,
			tool: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f*]+$" }),
			pin: Type.Union([ToolExposureStateSchema, Type.Null()]),
			...PinTargetProperties,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("native"),
			tool: StringEnum(NATIVE_PINNABLE_TOOLS),
			pin: Type.Union([StringEnum(["direct", "deferred"] as const), Type.Null()]),
			...PinTargetProperties,
		},
		{ additionalProperties: false },
	),
]);
export type ToolPinCommand = Static<typeof ToolPinCommandSchema>;
