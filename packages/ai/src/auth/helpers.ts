import type { ApiKeyAuth, AuthInteraction, Credential, OAuthAuth } from "./types.ts";

/** Signed-out account registrations are not authentication credentials. */
export function isActiveCredential(credential: Credential | undefined): credential is Credential {
	return credential !== undefined && !(credential.type === "oauth" && credential.signedOut === true);
}

/**
 * Standard api-key auth: a stored credential key wins, otherwise the first
 * set env var resolves. Includes a `login` that prompts for the key.
 * Providers with non-standard resolution (provider env, ambient files, IAM)
 * write their own `ApiKeyAuth`.
 */
export function envApiKeyAuth(
	name: string,
	envVars: readonly string[],
	keyPage?: string,
	verify?: ApiKeyAuth["verify"],
): ApiKeyAuth {
	return {
		name,
		...(verify ? { verify } : {}),
		...(keyPage ? { keyPage } : {}),
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			if (keyPage) showKeyPage(interaction, keyPage, name);
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * Points the user at the page where the provider issues keys: hosts open it in the browser (an `auth_url` event) and
 * show the address, so a key can be created and pasted without searching for the page.
 */
export function showKeyPage(interaction: Pick<AuthInteraction, "notify">, url: string, name: string): void {
	interaction.notify({
		type: "auth_url",
		url,
		instructions: `Create or copy your ${name} on this page, then paste it here.`,
	});
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 */
export function lazyOAuth(input: {
	name: string;
	isSubscription?: boolean;
	loginLabel?: string;
	/** Only flows with remote session revocation opt in to loading on logout. */
	canLogout?: boolean;
	load: () => Promise<OAuthAuth>;
}): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		isSubscription: input.isSubscription,
		loginLabel: input.loginLabel,
		login: async (interaction, options) => (await loaded()).login(interaction, options),
		refresh: async (credential, signal) => (await loaded()).refresh(credential, signal),
		...(input.canLogout
			? {
					logout: async (credential: Parameters<NonNullable<OAuthAuth["logout"]>>[0], signal: AbortSignal) => {
						const flow = await loaded();
						if (!flow.logout) throw new Error("OAuth logout is not available");
						return flow.logout(credential, signal);
					},
				}
			: {}),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
