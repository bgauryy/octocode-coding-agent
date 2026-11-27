/** models.json credential fields beside Pi's `apiKey`: a structured key command and environment variable names. */

import { Type } from "typebox";

const MAX_COMMAND_TIMEOUT_MS = 120_000;

const CredentialCommandSchema = Type.Object(
	{
		command: Type.String({
			minLength: 1,
			description: "Program that prints the key on stdout; runs without a shell, on first use.",
		}),
		args: Type.Optional(Type.Array(Type.String(), { description: "Arguments, passed as they are." })),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_COMMAND_TIMEOUT_MS,
				default: 10_000,
				description: "Milliseconds before the command is stopped and the request fails.",
			}),
		),
		ttlMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				default: 300_000,
				description:
					"Milliseconds the printed key is reused; 0 runs the command for every request. A request the provider refuses (401) runs it again.",
			}),
		),
	},
	{
		additionalProperties: false,
		description: "Key command, used before env and apiKey. Its stdout, trimmed, is the key.",
	},
);

/** Spread into the provider entry schema. */
export const ProviderCredentialProperties = {
	auth: Type.Optional(CredentialCommandSchema),
	env: Type.Optional(
		Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), {
			minItems: 1,
			description: "Environment variables that may hold the key; the first one set is used, else apiKey.",
		}),
	),
};

/** Whether the entry's key comes from a program: a key command or a `keychain:` reference. */
export function usesCredentialProgram(provider: { auth?: unknown; apiKey?: string }): boolean {
	return provider.auth !== undefined || (provider.apiKey?.startsWith("keychain:") ?? false);
}
