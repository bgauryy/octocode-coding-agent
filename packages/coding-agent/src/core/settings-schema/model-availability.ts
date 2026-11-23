import { Type } from "typebox";

/** Which models and providers the user lets the session use. */
export const ModelAvailabilitySettingsProperties = {
	enabledExternalAgents: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Vendor CLI ids allowed for external agent tasks when externalAgents is on. An empty list allows none; omitted preserves all runners for an existing explicit externalAgents: true. Global only; manage individual agents in /providers.",
		}),
	),
	enabledModels: Type.Optional(
		Type.Array(Type.String(), {
			description: "Model patterns for cycling, in the same format as the --models CLI flag.",
		}),
	),
	disabledProviders: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Provider ids turned off in /providers. Their models leave the model selector, cycling and subagent routing; saved credentials stay. Global only.",
		}),
	),
	hiddenModels: Type.Optional(
		Type.Record(Type.String(), Type.Array(Type.String()), {
			description:
				"Per provider, the model ids hidden by unticking them on its /providers page or the web provider page. Hidden models leave the model selector, cycling and subagent routing; a provider with no entry shows all its models. Global only.",
		}),
	),
	modelCatalogUpdates: Type.Optional(
		Type.Boolean({
			description:
				"Apply the daily models.dev index to the built-in catalog: newer prices and limits, deprecation marks, and new models of a known family on providers built from models.dev. Off keeps the catalog shipped with Octocode; OCTOCODE_MODELS_DEV=0 also turns it off, and --offline keeps the saved index without fetching. Global only; read once per process, so a change applies after a restart.",
			default: true,
		}),
	),
	providerSources: Type.Optional(
		Type.Object(
			{
				pi: Type.Optional(
					Type.Boolean({
						description:
							"Use Pi's auth.json (read-only fallback) and models.json. On by default; false leaves them out of availability without changing Pi's files.",
					}),
				),
				"copilot-env": Type.Optional(
					Type.Boolean({
						description:
							"Use the COPILOT_GITHUB_TOKEN environment variable as the github-copilot credential. Off by default.",
					}),
				),
			},
			{
				description:
					"Provider sources you changed from their defaults (Octocode and Pi on, COPILOT_GITHUB_TOKEN off), managed in /providers. Global only.",
			},
		),
	),
};
