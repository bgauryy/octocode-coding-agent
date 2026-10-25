/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove SDK/Zod dependencies and use WebCrypto for PKCE.
 */

import type { McpFetch } from "../auth-provider.ts";
import { isObject } from "../protocol/jsonrpc.ts";
import { OAuthError, OAuthInsecureEndpointError, OAuthRegistrationError } from "./errors.ts";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformation,
	type OAuthClientInformationFull,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthTokens,
	parseClientInformation,
	parseOAuthTokens,
} from "./types.ts";

export type AddClientAuthentication = (
	headers: Headers,
	params: URLSearchParams,
	url: string | URL,
	metadata?: AuthorizationServerMetadata,
) => void | Promise<void>;

type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

export interface TokenRequestOptions {
	metadata?: AuthorizationServerMetadata;
	clientInformation: OAuthClientInformationMixed;
	resource?: string;
	addClientAuthentication?: AddClientAuthentication;
	fetch?: McpFetch;
	signal?: AbortSignal;
}

function loopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * The OpenID Connect `application_type` for `redirect_uris` (MCP SEP-837). Without one, OpenID Connect servers
 * assume `web`, which rejects http loopback redirect URIs. Loopback hosts and custom schemes are native (RFC 8252).
 */
function applicationType(redirectUris: readonly string[]): "native" | "web" {
	const native = redirectUris.some((uri) => {
		if (!URL.canParse(uri)) return false;
		const url = new URL(uri);
		return (url.protocol !== "http:" && url.protocol !== "https:") || loopback(url.hostname);
	});
	return native ? "native" : "web";
}

export function secureEndpoint(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" && !loopback(url.hostname)) throw new OAuthInsecureEndpointError(url.href);
	return url;
}

function selectClientAuthMethod(information: OAuthClientInformationMixed, supported: string[]): ClientAuthMethod {
	const hinted = "token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined;
	if (
		hinted &&
		["client_secret_basic", "client_secret_post", "none"].includes(hinted) &&
		(supported.length === 0 || supported.includes(hinted))
	) {
		return hinted as ClientAuthMethod;
	}
	if (supported.length === 0) return information.client_secret ? "client_secret_basic" : "none";
	if (information.client_secret && supported.includes("client_secret_basic")) return "client_secret_basic";
	if (information.client_secret && supported.includes("client_secret_post")) return "client_secret_post";
	if (supported.includes("none")) return "none";
	return information.client_secret ? "client_secret_post" : "none";
}

function applyClientAuthentication(
	method: ClientAuthMethod,
	information: OAuthClientInformation,
	headers: Headers,
	params: URLSearchParams,
): void {
	if (method === "client_secret_basic") {
		if (!information.client_secret) throw new Error("client_secret_basic requires a client secret");
		headers.set(
			"Authorization",
			`Basic ${Buffer.from(`${information.client_id}:${information.client_secret}`).toString("base64")}`,
		);
	} else {
		params.set("client_id", information.client_id);
		if (method === "client_secret_post" && information.client_secret)
			params.set("client_secret", information.client_secret);
	}
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = Buffer.from(bytes).toString("base64url");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export async function startAuthorization(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientInformation: OAuthClientInformationMixed;
		redirectUrl: string | URL;
		scope?: string;
		state?: string;
		resource?: string;
	},
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
	const metadata = options.metadata;
	if (metadata && !metadata.response_types_supported.includes("code")) {
		throw new Error("Authorization server does not support authorization codes");
	}
	if (metadata?.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
		throw new Error("Authorization server does not support PKCE S256");
	}
	const url = new URL(metadata?.authorization_endpoint ?? new URL("/authorize", authorizationServerUrl));
	const { verifier, challenge } = await pkce();
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", options.clientInformation.client_id);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("redirect_uri", String(options.redirectUrl));
	if (options.state) url.searchParams.set("state", options.state);
	if (options.scope) url.searchParams.set("scope", options.scope);
	if (options.scope?.split(/\s+/).includes("offline_access")) url.searchParams.set("prompt", "consent");
	if (options.resource) url.searchParams.set("resource", options.resource);
	return { authorizationUrl: url, codeVerifier: verifier };
}

async function tokenRequest(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions,
	params: URLSearchParams,
): Promise<OAuthTokens> {
	const url = secureEndpoint(options.metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
	const headers = new Headers({ Accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
	if (options.resource) params.set("resource", options.resource);
	if (options.addClientAuthentication) {
		await options.addClientAuthentication(headers, params, url, options.metadata);
	} else {
		applyClientAuthentication(
			selectClientAuthMethod(options.clientInformation, options.metadata?.token_endpoint_auth_methods_supported ?? []),
			options.clientInformation,
			headers,
			params,
		);
	}
	const response = await (options.fetch ?? globalThis.fetch)(url, {
		method: "POST",
		headers,
		body: params,
		signal: options.signal,
	});
	const text = await response.text();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {}
	// Servers may report OAuth errors with any status, so check the body before the status.
	if (isObject(value) && typeof value.error === "string") {
		throw new OAuthError(
			value.error,
			typeof value.error_description === "string" ? value.error_description : value.error,
			typeof value.error_uri === "string" ? value.error_uri : undefined,
		);
	}
	if (!response.ok) throw new OAuthError("server_error", `HTTP ${response.status}: ${text}`);
	return parseOAuthTokens(value);
}

export async function registerClient(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientMetadata: OAuthClientMetadata;
		scope?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	},
): Promise<OAuthClientInformationFull> {
	const endpoint = options.metadata?.registration_endpoint;
	if (options.metadata && !endpoint)
		throw new Error("Authorization server does not support dynamic client registration");
	const response = await (options.fetch ?? globalThis.fetch)(
		new URL(endpoint ?? new URL("/register", authorizationServerUrl)),
		{
			method: "POST",
			headers: { Accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({
				...options.clientMetadata,
				application_type:
					options.clientMetadata.application_type ?? applicationType(options.clientMetadata.redirect_uris),
				...(options.scope ? { scope: options.scope } : {}),
			}),
			signal: options.signal,
		},
	);
	if (!response.ok) throw new OAuthRegistrationError(response.status, await response.text());
	return parseClientInformation(await response.json());
}

export async function exchangeAuthorizationCode(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { code: string; codeVerifier: string; redirectUrl: string | URL },
): Promise<OAuthTokens> {
	return tokenRequest(
		authorizationServerUrl,
		options,
		new URLSearchParams({
			grant_type: "authorization_code",
			code: options.code,
			code_verifier: options.codeVerifier,
			redirect_uri: String(options.redirectUrl),
		}),
	);
}

export async function refreshAuthorization(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { refreshToken: string },
): Promise<OAuthTokens> {
	const tokens = await tokenRequest(
		authorizationServerUrl,
		options,
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken }),
	);
	return { refresh_token: options.refreshToken, ...tokens };
}
