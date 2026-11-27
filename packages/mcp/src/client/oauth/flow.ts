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
import type { AuthProvider, UnauthorizedContext } from "../auth-provider.ts";
import { parseWwwAuthenticate } from "./discovery.ts";
import { McpOAuthAuthorizationRequiredError } from "./errors.ts";
import { createSdkOAuthProvider } from "./sdk-provider.ts";
import { oauthFetch, sdkOAuth } from "./sdk.ts";
import type { OAuthClientProvider, OAuthFlowOptions } from "./types.ts";

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
