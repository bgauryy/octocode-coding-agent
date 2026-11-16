import { Type } from "typebox";

/** The `timer` settings of the root schema. */
export const TimerSettingsProperties = {
	timer: Type.Optional(
		Type.Object(
			{
				check: Type.Optional(
					Type.Object(
						{
							enabled: Type.Optional(
								Type.Boolean({
									description:
										"Let a wait's check call a cheaper model to judge a condition after its event holds. It spends money, so it is off until you turn it on here or answer the first-use question; caps: 5 judgments and $0.05 per wait, $0.25 per session. Read from the global settings file; a project file cannot turn it on.",
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
