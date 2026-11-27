/*
 * Originally adapted from modelcontextprotocol/typescript-sdk v1.29.0.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Protocol types and validation now come from the official SDK.
 */

import type {
	AddClientAuthentication,
	AuthorizationServerMetadata,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	StoredOAuthClientInformation as OAuthClientInformationMixed,
	StoredOAuthTokens as OAuthTokens,
} from "@modelcontextprotocol/client";
import type { McpFetch } from "../auth-provider.ts";

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
