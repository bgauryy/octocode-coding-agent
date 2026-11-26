import { type Static, Type } from "typebox";

/** One external CLI or ACP agent the user offers as a main-session provider. */
const ExternalModelEntrySchema = Type.Object(
	{
		id: Type.String({
			pattern: "^[a-z0-9][a-z0-9._-]*$",
			description:
				"Provider id its models are listed under (`<id>/<model>`). Lowercase letters, digits, dot, dash and underscore; must not be the id of a built-in provider.",
		}),
		name: Type.Optional(Type.String({ minLength: 1, description: "Display name; the id when absent." })),
		kind: Type.Union([Type.Literal("acp"), Type.Literal("cli")], {
			description:
				"acp: an Agent Client Protocol agent over stdio, one session per Octocode session, given Octocode's tools over MCP. cli: one process per request, the conversation on stdin and its stdout as the reply, without Octocode's tools.",
		}),
		command: Type.String({ minLength: 1, description: "The executable: a name looked up on PATH, or a path." }),
		args: Type.Optional(
			Type.Array(Type.String(), { description: "Its arguments; for kind cli, {model} becomes the chosen model id." }),
		),
		env: Type.Optional(
			Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), {
				description:
					"Names of environment variables passed to it from Octocode's environment; every other credential variable is removed.",
			}),
		),
		models: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description:
					"Model ids it offers; default when absent. default leaves the choice to the CLI; another id is selected through ACP (kind acp) or {model} (kind cli).",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ExternalModelEntry = Static<typeof ExternalModelEntrySchema>;

export const ExternalModelsSettingsProperties = {
	externalModels: Type.Optional(
		Type.Array(ExternalModelEntrySchema, {
			description:
				"Your own external CLI or ACP agents, offered in /model after the built-in CLIs. Entries of the global file load as written; a trusted project's entries are added, each off until approved in /security, and asked again when its command, arguments or variable names change.",
		}),
	),
};
