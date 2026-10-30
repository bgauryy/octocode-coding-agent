/*
 * Originally adapted from modelcontextprotocol/typescript-sdk v1.29.0.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Protocol types and validation now come from the official SDK.
 */

export type {
	AuthorizationServerMetadata,
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	OAuthProtectedResourceMetadata,
	OAuthServerInfo,
	StoredOAuthClientInformation as OAuthClientInformationMixed,
	StoredOAuthTokens as OAuthTokens,
} from "@modelcontextprotocol/client";

export interface OAuthChallenge {
	resourceMetadataUrl?: URL;
	scope?: string;
	error?: string;
	errorDescription?: string;
}
