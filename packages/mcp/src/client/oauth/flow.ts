/*
 * Originally adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Authorization orchestration now delegates to the official SDK.
 */

import {
	auth,
	computeScopeUnion,
	type OAuthClientProvider as SdkOAuthClientProvider,
} from "@modelcontextprotocol/client";
import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.ts";
import { parseWwwAuthenticate } from "./discovery.ts";
import type { AddClientAuthentication } from "./endpoints.ts";
import { McpOAuthAuthorizationRequiredError } from "./errors.ts";
import { createSdkOAuthProvider } from "./sdk-provider.ts";
import { oauthFetch, sdkOAuth } from "./sdk.ts";
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

/** A step-up retains granted scopes as well as the new challenge's scopes. */
export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
	return challenged ? computeScopeUnion(granted, challenged) : undefined;
}

export async function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	options.signal?.throwIfAborted();
	const sdkProvider: SdkOAuthClientProvider = await createSdkOAuthProvider(provider, options);
	const result = await sdkOAuth(() =>
		auth(sdkProvider, {
			serverUrl: options.serverUrl,
			authorizationCode: options.authorizationCode,
			iss: options.iss,
			scope: options.scope,
			resourceMetadataUrl: options.resourceMetadataUrl,
			fetchFn: oauthFetch(options.fetch, options.signal),
			skipIssuerMetadataValidation: options.skipIssuerValidation,
			forceReauthorization: options.skipRefresh,
		}),
	);
	options.signal?.throwIfAborted();
	return result;
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
