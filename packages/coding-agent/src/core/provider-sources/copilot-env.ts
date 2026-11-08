import type { AuthContext, Provider } from "@octocodeai/octocode-ai";
import { providerSourceGate } from "./gate.ts";

export const COPILOT_ENV_VAR = "COPILOT_GITHUB_TOKEN";

/**
 * The `github-copilot` provider with `COPILOT_GITHUB_TOKEN` honoured only while the `copilot-env` source is on. When on,
 * the provider's own environment path supplies the credential and labels it with the variable name; when off, the
 * variable is invisible to it. Other providers are returned unchanged.
 */
export function withCopilotEnvSource(
	provider: Provider,
	isEnabled = () => providerSourceGate.isEnabled("copilot-env"),
): Provider {
	const apiKey = provider.auth.apiKey;
	if (provider.id !== "github-copilot" || !apiKey) return provider;
	const filter = (ctx: AuthContext): AuthContext => ({
		...ctx,
		env: async (name) => (name === COPILOT_ENV_VAR && !isEnabled() ? undefined : ctx.env(name)),
	});
	return {
		...provider,
		auth: {
			...provider.auth,
			apiKey: {
				...apiKey,
				resolve: (input) => apiKey.resolve({ ...input, ctx: filter(input.ctx) }),
				...(apiKey.check ? { check: (input) => apiKey.check!({ ...input, ctx: filter(input.ctx) }) } : {}),
			},
		},
	};
}
