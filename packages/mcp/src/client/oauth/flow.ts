/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove SDK/Zod dependencies and use WebCrypto for PKCE.
 */

import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.ts";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	parseWwwAuthenticate,
	selectResource,
} from "./discovery.ts";
import {
	type AddClientAuthentication,
	exchangeAuthorizationCode,
	refreshAuthorization,
	registerClient,
	secureEndpoint,
	startAuthorization,
	type TokenRequestOptions,
} from "./endpoints.ts";
import {
	McpOAuthAuthorizationRequiredError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
} from "./errors.ts";
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	OAuthTokens,
} from "./types.ts";

/** A Client ID Metadata Document: an https URL used as `client_id`, and a redirect URI it lists. */
export interface OAuthClientMetadataDocument {
	url: string;
	redirectUrl: string;
}

export interface OAuthClientProvider {
	readonly redirectUrl: string | URL;
	readonly clientMetadata: OAuthClientMetadata;
	/**
	 * Client ID Metadata Document to identify as instead of registering dynamically, or `undefined` to
	 * register. Called when no client information is stored; the document is not stored. `metadata` is
	 * `undefined` when the authorization server has none; check `client_id_metadata_document_supported`.
	 */
	clientMetadataDocument?(metadata: AuthorizationServerMetadata | undefined): OAuthClientMetadataDocument | undefined;
	state?(): string | Promise<string>;
	clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
	saveClientInformation?(information: OAuthClientInformationMixed): void | Promise<void>;
	tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
	saveTokens(tokens: OAuthTokens): void | Promise<void>;
	redirectToAuthorization(url: URL): void | Promise<void>;
	saveCodeVerifier(verifier: string): void | Promise<void>;
	codeVerifier(): string | Promise<string>;
	addClientAuthentication?: AddClientAuthentication;
	invalidateCredentials?(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void | Promise<void>;
	saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
	discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
}

export interface OAuthFlowOptions {
	serverUrl: string | URL;
	authorizationCode?: string;
	/** `iss` parameter of the authorization response that delivered `authorizationCode` (RFC 9207). */
	iss?: string;
	scope?: string;
	resourceMetadataUrl?: URL;
	/**
	 * Authorization server metadata document to use instead of discovery, for servers that advertise a
	 * wrong authorization server or none. It is trusted as configured. Must use https, except on loopback.
	 */
	authorizationServerMetadataUrl?: URL;
	fetch?: McpFetch;
	/** Aborts every request of the flow. Requests have no time limit of their own; combine with a timeout as needed. */
	signal?: AbortSignal;
	skipIssuerValidation?: boolean;
	/**
	 * Go straight to the authorization redirect instead of refreshing stored tokens, for example when the
	 * server asks for scopes the current grant lacks (a refresh keeps the old scope).
	 */
	skipRefresh?: boolean;
}

export type OAuthFlowResult = "AUTHORIZED" | "REDIRECT";

function withScope(tokens: OAuthTokens, scope: string | undefined): OAuthTokens {
	return tokens.scope === undefined && scope ? { ...tokens, scope } : tokens;
}

/**
 * Scopes for a step-up authorization: the challenged scopes plus the ones granted so far, since a
 * challenge may list only the missing scopes and a token with just those would lose access the old
 * one had (SEP-2350). Without challenged scopes, `undefined` lets the flow pick its default.
 */
export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
	if (!challenged) return undefined;
	const scopes = [granted, challenged].flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []);
	return [...new Set(scopes)].join(" ");
}

async function runFlow(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	const metadataUrl = options.authorizationServerMetadataUrl && secureEndpoint(options.authorizationServerMetadataUrl);
	// With a configured metadata URL, discovery is not cached, so changing the URL applies at once.
	const cached = metadataUrl ? undefined : await provider.discoveryState?.();
	const discovered = cached?.authorizationServerUrl
		? {
				authorizationServerUrl: cached.authorizationServerUrl,
				authorizationServerMetadata:
					cached.authorizationServerMetadata ??
					(await discoverAuthorizationServerMetadata(cached.authorizationServerUrl, {
						fetch: options.fetch,
						skipIssuerValidation: options.skipIssuerValidation,
						signal: options.signal,
					})),
				resourceMetadata: cached.resourceMetadata,
			}
		: await discoverOAuthServerInfo(options.serverUrl, {
				resourceMetadataUrl: options.resourceMetadataUrl,
				authorizationServerMetadataUrl: metadataUrl,
				fetch: options.fetch,
				skipIssuerValidation: options.skipIssuerValidation,
				signal: options.signal,
			});
	if (!metadataUrl) {
		await provider.saveDiscoveryState?.({
			...discovered,
			...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl.href } : {}),
		});
	}
	const metadata = discovered.authorizationServerMetadata;
	const resource = selectResource(options.serverUrl, discovered.resourceMetadata);
	// `||`, not `??`: an empty scope (for example from `scopes_supported: []`) falls through to the next source.
	const scope =
		options.scope || discovered.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope;
	const stored = await provider.clientInformation();
	const clientDocument = stored ? undefined : provider.clientMetadataDocument?.(metadata);
	if (clientDocument) {
		const url = new URL(clientDocument.url);
		if (url.protocol !== "https:" || url.pathname === "/") throw new Error("Invalid OAuth client metadata URL");
	}
	let client = stored ?? (clientDocument && { client_id: clientDocument.url });
	if (!client) {
		if (options.authorizationCode) throw new Error("OAuth client information is missing during code exchange");
		if (!provider.saveClientInformation) throw new Error("OAuth client information cannot be persisted");
		client = await registerClient(discovered.authorizationServerUrl, {
			metadata,
			clientMetadata: provider.clientMetadata,
			scope,
			fetch: options.fetch,
			signal: options.signal,
		});
		await provider.saveClientInformation(client);
	}
	// The document's redirect URI may differ from the provider's, for example by a server-specific path.
	const redirectUrl = clientDocument?.redirectUrl ?? provider.redirectUrl;
	const tokenOptions: TokenRequestOptions = {
		metadata,
		clientInformation: client,
		resource,
		addClientAuthentication: provider.addClientAuthentication,
		fetch: options.fetch,
		signal: options.signal,
	};
	if (options.authorizationCode) {
		// RFC 9207: never send a code from another authorization server to this one. Without metadata there
		// is no issuer to compare with, so any `iss` is rejected.
		const iss = options.iss;
		if (iss !== undefined || metadata?.authorization_response_iss_parameter_supported) {
			if (iss !== metadata?.issuer) throw new OAuthIssuerMismatchError(metadata?.issuer, iss);
		}
		const tokens = await exchangeAuthorizationCode(discovered.authorizationServerUrl, {
			...tokenOptions,
			code: options.authorizationCode,
			codeVerifier: await provider.codeVerifier(),
			redirectUrl,
		});
		// A response without `scope` grants the requested scope (RFC 6749 §5.1). Recorded so a step-up can
		// keep it. Callers pass the options of the authorization request, so `scope` is what was requested.
		await provider.saveTokens(withScope(tokens, scope));
		return "AUTHORIZED";
	}
	const existing = options.skipRefresh ? undefined : await provider.tokens();
	if (existing?.refresh_token) {
		try {
			const tokens = await refreshAuthorization(discovered.authorizationServerUrl, {
				...tokenOptions,
				refreshToken: existing.refresh_token,
			});
			// A refresh without `scope` keeps the scope of the grant (RFC 6749 §6).
			await provider.saveTokens(withScope(tokens, existing.scope));
			return "AUTHORIZED";
		} catch (error) {
			if (options.signal?.aborted || error instanceof OAuthInsecureEndpointError) throw error;
			if (error instanceof OAuthError && error.code !== "server_error") throw error;
		}
	}
	const state = await provider.state?.();
	const authorization = await startAuthorization(discovered.authorizationServerUrl, {
		metadata,
		clientInformation: client,
		redirectUrl,
		scope,
		state,
		resource,
	});
	await provider.saveCodeVerifier(authorization.codeVerifier);
	await provider.redirectToAuthorization(authorization.authorizationUrl);
	return "REDIRECT";
}

export async function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	try {
		return await runFlow(provider, options);
	} catch (error) {
		if (error instanceof OAuthError && ["invalid_client", "unauthorized_client"].includes(error.code)) {
			await provider.invalidateCredentials?.("all");
			return runFlow(provider, options);
		}
		if (error instanceof OAuthError && error.code === "invalid_grant") {
			await provider.invalidateCredentials?.("tokens");
			return runFlow(provider, options);
		}
		throw error;
	}
}

/**
 * Auth provider for `StreamableHttpTransport`. After a 401 it refreshes the tokens, or throws
 * `McpOAuthAuthorizationRequiredError` when the user has to authorize (again). Concurrent 401s share
 * one refresh, and a request whose token was already replaced is just retried: with rotating refresh
 * tokens, a second refresh with the old refresh token would fail and discard the new grant. A 403 asking
 * for more scope shares only another step-up: a refresh keeps the granted scope, and a step-up skips the
 * refresh token, so neither can stand in for the other.
 *
 * Public API for standalone clients (see the README). The Octocode host has its own `AuthProvider` with a different
 * step-up policy (it asks the user to sign in again) and does not call this.
 */
export function adaptOAuthProvider(provider: OAuthClientProvider): AuthProvider {
	let refreshing: Promise<void> | undefined;
	let steppingUp: Promise<void> | undefined;
	const authorize = async (
		context: UnauthorizedContext,
		challenge: ReturnType<typeof parseWwwAuthenticate>,
		stepUp: boolean,
	) => {
		const granted = stepUp ? await provider.tokens() : undefined;
		const result = await authorizeMcp(provider, {
			serverUrl: context.serverUrl,
			resourceMetadataUrl: challenge.resourceMetadataUrl,
			scope: stepUp ? stepUpScope(granted?.scope, challenge.scope) : challenge.scope,
			fetch: context.fetch,
			skipRefresh: stepUp,
		});
		if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
	};
	return {
		token: async () => (await provider.tokens())?.access_token,
		onUnauthorized: async (context: UnauthorizedContext) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			if (challenge.error === "insufficient_scope") {
				steppingUp ??= authorize(context, challenge, true).finally(() => {
					steppingUp = undefined;
				});
				return steppingUp;
			}
			if (!refreshing && context.token !== undefined) {
				const current = (await provider.tokens())?.access_token;
				if (current !== undefined && current !== context.token) return;
			}
			refreshing ??= authorize(context, challenge, false).finally(() => {
				refreshing = undefined;
			});
			return refreshing;
		},
	};
}
