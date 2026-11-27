import {
	type ApiKeyAuth,
	type AuthContext,
	type AuthInteraction,
	type AuthResult,
	type ModelAuth,
	type OAuthAuth,
	type Provider,
	type ProviderHeaders,
} from "@octocodeai/octocode-ai";
import type { ModelsJsonProvider } from "../model-config.ts";
import { getConfigValueEnvVarNames, resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../config-value.ts";
import { configuredKey, configuredKeyAvailable, configuredKeyStatus, resolveConfiguredKey } from "./configured-key.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { registerAuthSecrets } from "../secret-redaction.ts";
import { type AuthStatus, credentialSourceLabel, type FeatureOAuthConfig, type ProviderConfigInput } from "./types.ts";

function adaptOAuth(config: FeatureOAuthConfig): OAuthAuth {
	return {
		name: config.name,
		isSubscription: config.isSubscription,
		login: async (callbacks) => {
			const credential = await config.login({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				onManualCodeInput: () => callbacks.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				onSelect: (prompt) => callbacks.prompt({ type: "select", ...prompt }),
				signal: callbacks.signal,
			});
			return { ...credential, type: "oauth" };
		},
		refresh: async (credential, signal) => ({ ...(await config.refreshToken(credential, signal)), type: "oauth" }),
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
	};
}

function withConfiguredAuth(
	auth: ModelAuth,
	headers: Record<string, string> | undefined,
	authHeader: boolean,
): ModelAuth {
	let mergedHeaders: ProviderHeaders | undefined =
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

/** How the provider's own configuration supplies a key: a secret command, variables, or the key itself; undefined for none. */
export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	return configuredKeyStatus(configuredKey(config, feature));
}

export function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	if (!config?.headers && !feature?.headers) return undefined;
	return { ...config?.headers, ...feature?.headers };
}

async function configContextEnv(
	values: readonly string[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

export function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput | undefined,
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const key = configuredKey(config, feature);
	// Where a configured key comes from, in the words a provider's page uses (`models.json`, a variable name); set with `key`.
	const configuredStatus = configuredKeyStatus(key);
	const configuredSource = configuredStatus && credentialSourceLabel(configuredStatus);
	const oauth = feature?.oauth ?? base?.auth.oauth;
	// OAuth-only providers get no fabricated API-key login method.
	if (!inherited && key === undefined && oauth) return undefined;
	const rawHeaders = configuredHeaders(config, feature);
	const authHeader = feature?.authHeader ?? config?.authHeader ?? false;
	return {
		name: inherited?.name ?? "API key",
		login:
			inherited?.login ??
			(async (interaction: AuthInteraction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
			})),
		check: async (input) => {
			if (input.credential) {
				if (inherited?.check) return inherited.check(input);
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				const resolved = await inherited?.resolve(input);
				return resolved ? { type: "api_key", source: resolved.source } : undefined;
			}
			if (key !== undefined) {
				return (await configuredKeyAvailable(key, input.ctx))
					? { type: "api_key", source: configuredSource }
					: undefined;
			}
			if (inherited?.check) return inherited.check(input);
			const resolved = await inherited?.resolve(input);
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		resolve: async (input) => {
			let result: AuthResult | undefined;
			if (input.credential) {
				result = inherited
					? await inherited.resolve(input)
					: input.credential.key
						? { auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" }
						: undefined;
			} else if (key !== undefined) {
				const description = `API key for provider "${providerId}"`;
				let configured: Awaited<ReturnType<typeof resolveConfiguredKey>>;
				try {
					configured = await resolveConfiguredKey(key, input.ctx, input.signal);
				} catch (error) {
					throw new Error(`Failed to resolve ${description}: ${errorMessage(error)}`, { cause: error });
				}
				const resolved: { key: string; source?: string; renew?: () => void } =
					"value" in configured
						? {
								key: resolveConfigValueOrThrow(
									configured.value,
									description,
									await configContextEnv([configured.value], input.ctx),
								),
							}
						: configured;
				const source = resolved.source ?? configuredSource;
				result = inherited
					? await inherited.resolve({ ...input, credential: { type: "api_key", key: resolved.key } })
					: { auth: { apiKey: resolved.key }, source };
				if (resolved.renew) result = result && { ...result, renew: resolved.renew };
			} else {
				result = await inherited?.resolve(input);
			}
			if (!result) return undefined;
			const explicitEnv = { ...input.credential?.env, ...result.env };
			const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			const auth = withConfiguredAuth(result.auth, headers, authHeader);
			// What the request carries, from stored, configured, command or environment sources alike: errors may quote it.
			registerAuthSecrets(auth, explicitEnv);
			return { ...result, auth };
		},
	};
}

export function composeOAuthAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput | undefined,
): OAuthAuth | undefined {
	const oauth = feature?.oauth ? adaptOAuth(feature.oauth) : base?.auth.oauth;
	if (!oauth) return undefined;
	const rawHeaders = configuredHeaders(config, feature);
	const authHeader = feature?.authHeader ?? config?.authHeader ?? false;
	return {
		...oauth,
		toAuth: async (credential) => {
			const auth = await oauth.toAuth(credential);
			const env = credential.env;
			const headers = resolveHeadersOrThrow(
				rawHeaders,
				`provider "${providerId}"`,
				typeof env === "object" && env !== null ? (env as Record<string, string>) : undefined,
			);
			const configured = withConfiguredAuth(auth, headers, authHeader);
			registerAuthSecrets(configured);
			return configured;
		},
	};
}
