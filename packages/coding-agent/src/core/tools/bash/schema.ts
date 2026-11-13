import { type Static, Type } from "typebox";

/** The per-call output budget; the native `bash` tool declares the same parameter. */
export const maxOutputTokensParameter = Type.Optional(
	Type.Number({
		description: "Result token budget (about 4 bytes each; minimum 100)",
	}),
);

export const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Seconds before stopping; no default timeout" })),
	maxOutputTokens: maxOutputTokensParameter,
});

export type BashToolInput = Static<typeof bashSchema>;
