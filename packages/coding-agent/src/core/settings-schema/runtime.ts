import { Type } from "typebox";

export const MAX_EVENT_WINDOW_SECONDS = 10;

/** Defaults for a session without runtime overrides. */
export const RUNTIME_DEFAULTS = {
	eventWindowSeconds: 2,
} as const;

/** The `runtime` settings of the root schema. */
export const RuntimeSettingsProperties = {
	runtime: Type.Optional(
		Type.Object(
			{
				eventLoop: Type.Optional(
					Type.String({
						description:
							"Ignored. The event loop is the only session scheduler; the key is still accepted so a settings file written for an earlier version loads.",
					}),
				),
				eventWindowSeconds: Type.Optional(
					Type.Number({
						description:
							"Seconds the event loop waits after a background event wakes an idle session, so completions that arrive together share one turn. User input releases the window immediately.",
						default: RUNTIME_DEFAULTS.eventWindowSeconds,
						minimum: 0,
						maximum: MAX_EVENT_WINDOW_SECONDS,
					}),
				),
				smartRouting: Type.Optional(
					Type.Object(
						{
							allow: Type.Optional(
								Type.Array(Type.String({ minLength: 1 }), {
									description:
										'Provider/model patterns the native octocode/auto-code router may select, for example ["openai/gpt-5*", "anthropic/*"]. Empty or omitted allows every eligible model.',
									maxItems: 64,
								}),
							),
							deny: Type.Optional(
								Type.Array(Type.String({ minLength: 1 }), {
									description: "Provider/model patterns auto-code never selects. Deny rules win over allow rules.",
									maxItems: 64,
								}),
							),
							tiers: Type.Optional(
								Type.Record(Type.String(), Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]), {
									description:
										"Capability tier overrides keyed by provider/model pattern: 1 light, 2 general, 3 frontier. The first matching pattern wins.",
								}),
							),
							planOnly: Type.Optional(
								Type.Boolean({
									description: "Restrict auto-code to flat-rate subscription or coding-plan models. Default false.",
									default: false,
								}),
							),
							allowPlanToMeteredEscalation: Type.Optional(
								Type.Boolean({
									description:
										"Allow a session that used a flat-rate plan to switch to per-token billing. Default false. Global settings only.",
									default: false,
								}),
							),
							cooldownRequests: Type.Optional(
								Type.Integer({
									description: "Routed requests for which auto-code skips a recently failed model. Default 4.",
									default: 4,
									minimum: 0,
									maximum: 64,
								}),
							),
							outputReserveTokens: Type.Optional(
								Type.Integer({
									description:
										"Output tokens auto-code reserves when checking whether the conversation fits a candidate. Default 8192.",
									default: 8192,
									minimum: 0,
									maximum: 200000,
								}),
							),
						},
						{
							description:
								"Native octocode/auto-code routing policy. The router runs only when that virtual model is selected.",
							additionalProperties: false,
						},
					),
				),
			},
			{ additionalProperties: false },
		),
	),
};
