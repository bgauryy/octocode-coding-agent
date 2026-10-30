/*
 * Originally adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Discovery and challenge parsing now delegate to the official SDK.
 */

import {
	buildDiscoveryUrls,
	checkResourceAllowed,
	discoverAuthorizationServerMetadata as sdkDiscoverAuthorization,
	discoverOAuthProtectedResourceMetadata,
	discoverOAuthServerInfo as sdkDiscoverServer,
	extractWWWAuthenticateParams,
	resourceUrlFromServerUrl,
} from "@modelcontextprotocol/client";
import { OAuthMetadataSchema } from "@modelcontextprotocol/core";
import type { McpFetch } from "../auth-provider.ts";
import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
import { secureEndpoint } from "./endpoints.ts";
import { oauthFetch, sdkOAuth } from "./sdk.ts";
import type {
	AuthorizationServerMetadata,
	OAuthChallenge,
	OAuthProtectedResourceMetadata,
	OAuthServerInfo,
} from "./types.ts";

export { resourceUrlFromServerUrl };
export const buildAuthorizationServerDiscoveryUrls = buildDiscoveryUrls;

export function parseWwwAuthenticate(header: string | null): OAuthChallenge {
	return extractWWWAuthenticateParams(new Response(null, { headers: header ? { "www-authenticate": header } : {} }));
}

export function discoverProtectedResourceMetadata(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: string | URL;
		protocolVersion?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthProtectedResourceMetadata> {
	return sdkOAuth(() =>
		discoverOAuthProtectedResourceMetadata(
			serverUrl,
			{
				resourceMetadataUrl: options.resourceMetadataUrl && new URL(options.resourceMetadataUrl),
				protocolVersion: options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
			},
			oauthFetch(options.fetch, options.signal),
		),
	);
}

export function discoverAuthorizationServerMetadata(
	authorizationServerUrl: string | URL,
	options: { fetch?: McpFetch; protocolVersion?: string; skipIssuerValidation?: boolean; signal?: AbortSignal } = {},
): Promise<AuthorizationServerMetadata | undefined> {
	return sdkOAuth(() =>
		sdkDiscoverAuthorization(authorizationServerUrl, {
			fetchFn: oauthFetch(options.fetch, options.signal),
			protocolVersion: options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
			skipIssuerValidation: options.skipIssuerValidation,
		}),
	);
}

export async function discoverOAuthServerInfo(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: URL;
		/** Explicitly configured metadata document; its issuer is trusted as configured. */
		authorizationServerMetadataUrl?: URL;
		fetch?: McpFetch;
		skipIssuerValidation?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthServerInfo> {
	const fetch = oauthFetch(options.fetch, options.signal);
	if (!options.authorizationServerMetadataUrl) {
		return sdkOAuth(() =>
			sdkDiscoverServer(serverUrl, {
				resourceMetadataUrl: options.resourceMetadataUrl,
				fetchFn: fetch,
				skipIssuerMetadataValidation: options.skipIssuerValidation,
			}),
		);
	}
	// Endpoint overrides are a host configuration feature, outside SDK discovery policy.
	const url = secureEndpoint(options.authorizationServerMetadataUrl);
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	try {
		resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, options);
	} catch (error) {
		options.signal?.throwIfAborted();
		if (error instanceof TypeError) throw error;
	}
	const response = await fetch(url, {
		headers: { Accept: "application/json", "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION },
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
	}
	const metadata = OAuthMetadataSchema.parse(await response.json());
	OAuthMetadataSchema.shape.authorization_endpoint.parse(metadata.issuer);
	return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
}

export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
	if (!metadata) return undefined;
	const requested = resourceUrlFromServerUrl(serverUrl);
	if (!checkResourceAllowed({ requestedResource: requested, configuredResource: metadata.resource })) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	return metadata.resource;
}
