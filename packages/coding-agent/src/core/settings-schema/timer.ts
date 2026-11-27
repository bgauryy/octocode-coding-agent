import { Type } from "typebox";

/** The `timer` settings of the root schema. */
export const TimerSettingsProperties = {
	timer: Type.Optional(
		Type.Object(
			{
				cron: Type.Optional(
					Type.Object(
						{
							enabled: Type.Optional(
								Type.Boolean({
									description:
										"Let a session without a screen to confirm on (print, JSON, RPC) set cron schedules with wait. Each run is a model turn with nobody attending, so it is off until you turn it on here; a session with a screen asks once instead. Read from the global settings file; a project file cannot turn it on.",
									default: false,
								}),
							),
							maxUsdPerSession: Type.Optional(
								Type.Number({
									description:
										"The most a session may spend, in USD, since its first cron schedule before cron runs stop. Read from the global settings file.",
									default: 2,
									minimum: 0,
								}),
							),
						},
						{ additionalProperties: false },
					),
				),
				check: Type.Optional(
					Type.Object(
						{
							enabled: Type.Optional(
								Type.Boolean({
									description:
										"Let a notify request's check call a cheaper model to judge a condition after its event holds. It spends money, so it is off until you turn it on here or answer the first-use question; caps: 5 judgments and $0.05 per request, $0.25 per session. Read from the global settings file; a project file cannot turn it on.",
									default: false,
								}),
							),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
	),
};
