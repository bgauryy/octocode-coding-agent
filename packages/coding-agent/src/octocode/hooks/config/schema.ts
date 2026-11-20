import { type TSchema, Type } from "typebox";
import { HOOK_EVENTS, HOOK_CATALOG, PROFILE_COMMAND_FIELDS } from "../catalog.ts";
import { HOOK_MAX_TIMEOUT_S } from "../contracts.ts";

/** An object whose properties are optional unless named in `required`. */
function object(properties: Record<string, TSchema>, required: readonly string[] = []): TSchema {
	return Type.Object(
		Object.fromEntries(
			Object.entries(properties).map(([key, value]) => [key, required.includes(key) ? value : Type.Optional(value)]),
		),
		{ additionalProperties: false },
	);
}

const timeout = Type.Number({
	exclusiveMinimum: 0,
	maximum: HOOK_MAX_TIMEOUT_S,
	description: "Seconds before the hook is cancelled.",
});
const statusMessage = Type.String({ description: "Spinner text shown while the hook runs." });
const failClosed = Type.Boolean({ description: "A failure of a gate event denies the call instead of allowing it." });
const onFailure = Type.Union([Type.Literal("continue"), Type.Literal("block")], {
	description: "Whether the action goes ahead when the hook fails.",
});

/** Every command field some profile accepts (`PROFILE_COMMAND_FIELDS`); the profile of the file decides which apply. */
const commandFields: Record<string, TSchema> = {
	type: Type.Literal("command"),
	command: Type.String({ minLength: 1, description: "Shell command, or the executable when `args` is set." }),
	timeout,
	failClosed,
	sandbox: Type.Boolean({
		description: "Run inside the command sandbox; where it cannot start, the hook is not run and counts as failed.",
	}),
	statusMessage,
	args: Type.Array(Type.String(), { description: "Claude: argument list; spawns `command` without a shell." }),
	shell: Type.Union([Type.Literal("bash"), Type.Literal("powershell")], {
		description: "Claude: the shell that runs `command`.",
	}),
	onFailure,
	async: Type.Boolean({ description: "Claude and Codex: run in the background." }),
	asyncRewake: Type.Boolean({ description: "Claude: run in the background and wake the agent on exit code 2." }),
	commandWindows: Type.String({ description: "Codex: the command on Windows." }),
	additionalContextLimit: Type.Integer({ minimum: 0, description: "Codex: most characters of added context." }),
	if: Type.String({
		description: 'Claude: a permission rule such as "Bash(git *)"; the hook runs only for matching calls.',
	}),
	once: Type.Boolean({ description: "Claude: accepted and ignored outside skill frontmatter." }),
};

function commandHandler(): TSchema {
	const known = new Set(Object.values(PROFILE_COMMAND_FIELDS).flat());
	const unknown = [...known].filter((field) => !(field in commandFields) && field !== "if" && field !== "once");
	if (unknown.length > 0) throw new Error(`Hook schema lacks command fields: ${unknown.join(", ")}`);
	return object(commandFields, ["type", "command"]);
}

const httpHandler = object(
	{
		type: Type.Literal("http"),
		url: Type.String({ description: "http: only for loopback hosts; https otherwise." }),
		headers: Type.Record(Type.String(), Type.String()),
		allowedEnvVars: Type.Array(Type.String(), {
			description: "Variables that may be interpolated into header values.",
		}),
		timeout,
		onFailure,
		failClosed,
		statusMessage,
	},
	["type", "url"],
);

const promptHandler = object(
	{
		type: Type.Literal("prompt"),
		prompt: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		continueOnBlock: Type.Boolean(),
		timeout,
		failClosed,
		statusMessage,
	},
	["type", "prompt"],
);

const mcpHandler = object(
	{
		type: Type.Literal("mcp_tool"),
		server: Type.String({ minLength: 1 }),
		tool: Type.String({ minLength: 1 }),
		input: Type.Record(Type.String(), Type.Unknown()),
		timeout,
		statusMessage,
	},
	["type", "server", "tool"],
);

const handler = Type.Union([commandHandler(), httpHandler, promptHandler, mcpHandler]);

const group = object(
	{
		matcher: Type.String({
			description: "Regular expression over the tool name or trigger; empty or `*` matches all.",
		}),
		hooks: Type.Array(handler),
	},
	["hooks"],
);

/** The `hooks.json` file: events come from the catalog, handlers from the profile field tables. */
export const HooksFileSchema = object({
	$schema: Type.String(),
	hooks: object(
		Object.fromEntries(
			HOOK_EVENTS.map((event) => [event, Type.Array(group, { description: HOOK_CATALOG[event].behavior })]),
		),
	),
	disableAllHooks: Type.Boolean({ description: "Turns every hook off, required gates included." }),
});
