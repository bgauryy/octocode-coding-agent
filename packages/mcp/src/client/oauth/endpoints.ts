/*
 * Originally adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * OAuth wire operations now delegate to the official SDK.
 */

import {
	assertSecureTokenEndpoint,
	exchangeAuthorization,
	refreshAuthorization as sdkRefresh,
	registerClient as sdkRegister,
	resolveClientMetadata,
	type AddClientAuthentication,
} from "@modelcontextprotocol/client";
import type { McpFetch } from "../auth-provider.ts";
import { oauthError, oauthFetch, sdkOAuth } from "./sdk.ts";
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "./types.ts";

export { startAuthorization, type AddClientAuthentication } from "@modelcontextprotocol/client";

export interface TokenRequestOptions {
	metadata?: AuthorizationServerMetadata;
	clientInformation: OAuthClientInformationMixed;
	resource?: string;
	addClientAuthentication?: AddClientAuthentication;
	fetch?: McpFetch;
	signal?: AbortSignal;
}

export function secureEndpoint(value: string | URL): URL {
	try {
		return assertSecureTokenEndpoint(value);
	} catch (error) {
		throw oauthError(error);
	}
}

export function registerClient(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientMetadata: OAuthClientMetadata;
		scope?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	},
): Promise<OAuthClientInformationFull> {
	return sdkOAuth(() =>
		sdkRegister(authorizationServerUrl, {
			metadata: options.metadata,
			clientMetadata: resolveClientMetadata({ clientMetadata: options.clientMetadata, redirectUrl: undefined }),
			scope: options.scope,
			fetchFn: oauthFetch(options.fetch, options.signal),
		}),
	);
}

export function exchangeAuthorizationCode(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { code: string; codeVerifier: string; redirectUrl: string | URL; iss?: string },
): Promise<OAuthTokens> {
	return sdkOAuth(() =>
		exchangeAuthorization(authorizationServerUrl, {
			...options,
			authorizationCode: options.code,
			redirectUri: options.redirectUrl,
			fetchFn: oauthFetch(options.fetch, options.signal),
		}),
	);
}

export function refreshAuthorization(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { refreshToken: string },
): Promise<OAuthTokens> {
	return sdkOAuth(() =>
		sdkRefresh(authorizationServerUrl, {
			...options,
			fetchFn: oauthFetch(options.fetch, options.signal),
		}),
	);
}
