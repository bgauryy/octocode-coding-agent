import { type Static, Type } from "typebox";

/** The per-call output budget, lower than the `bashOutputMaxBytes` setting only; the native `bash` tool declares the same parameter. */
export const maxOutputTokensParameter = Type.Optional(
	Type.Number({
		description:
			"Result token budget (~4 bytes each, min 100); lowers the bashOutputMaxBytes budget, never raises it; full output is saved either way",
	}),
);

export const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Seconds before stopping; no default timeout" })),
	maxOutputTokens: maxOutputTokensParameter,
});

export type BashToolInput = Static<typeof bashSchema>;
