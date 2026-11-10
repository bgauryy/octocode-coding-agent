/** Loopback callback settings, timed requests and the OAuth provider shared by refreshes and sign-ins. */

import { createHash } from "node:crypto";
import type { McpFetch } from "../client/index.ts";
import {
	type AuthorizationServerMetadata,
	McpOAuthProvider,
	type McpOAuthStateStore,
	type OAuthClientInformationMixed,
	type OAuthClientMetadataDocument,
} from "../client/oauth/index.ts";
import { hostIdentity } from "../host.ts";

const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PATH = "/callback";

/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
export const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/**
 * Bounds each request to the authorization server, so an unresponsive one cannot hold the refresh lock,
 * delay shutdown, or keep a sign-in waiting for long.
 */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

export interface McpOAuthSettings {
	clientId?: string;
	/** Already resolved. */
	clientSecret?: string;
	callbackPort?: number;
	/** Loopback redirect URI; see `McpOAuthConfig.callbackUrl`. */
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. */
	scope?: string;
	/** `client_name` for dynamic client registration. Default: `APP_NAME`. */
	clientName?: string;
	/** See `McpOAuthConfig.clientRegistration`. */
	clientRegistration?: "dcr" | "cimd";
	authServerMetadataUrl?: URL;
}

/** Where the loopback callback server listens and the redirect URI it serves. */
export interface CallbackSettings {
	/** Address to listen on. */
	host: string;
	/** Host name in the redirect URI. */
	redirectHost: string;
	port: number | undefined;
	path: string;
	/** The exact redirect URI, when the port is fixed. */
	fixedRedirectUrl: string | undefined;
}

export function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
	const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : settings.callbackPort;
	let fixedRedirectUrl: string | undefined;
	// A configured URI with a port is sent exactly as written, since servers compare it as a string.
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixedRedirectUrl = url.href;
	}
	return {
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}

/** Scopes of both lists, each once. */
export function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return merged.length > 0 ? merged.join(" ") : undefined;
}

/** `fetch` with `OAUTH_REQUEST_TIMEOUT_MS` per request, on top of the request's own signal. */
export function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

export function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

/** 12 characters identifying an MCP server URL in callback paths. */
export function callbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

/**
 * The configured Client ID Metadata Document for `clientRegistration: "cimd"`.
 * The configuration ensures the default callback path. Without the `iss` parameter in authorization
 * responses (RFC 9207), the redirect URI and the document are specific to the MCP server, so a response
 * cannot be mixed up with one from another authorization server (RFC 9700 section 4.4.2.2).
 */
function clientMetadataDocument(
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument {
	const clientMetadataBaseUrl = process.env.OCTOCODE_MCP_CLIENT_METADATA_URL?.replace(/\/+$/, "");
	if (!clientMetadataBaseUrl)
		throw new Error(
			"Client metadata registration requires OCTOCODE_MCP_CLIENT_METADATA_URL; use dynamic registration or a configured client ID instead.",
		);
	if (
		!metadata?.client_id_metadata_document_supported ||
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		throw new Error(
			'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
		);
	}
	if (metadata.authorization_response_iss_parameter_supported) {
		return { url: `${clientMetadataBaseUrl}/client.json`, redirectUrl };
	}
	const id = callbackId(serverUrl);
	const redirect = new URL(redirectUrl);
	redirect.pathname = `${CALLBACK_PATH}/${id}`;
	return { url: `${clientMetadataBaseUrl}/${id}/client.json`, redirectUrl: redirect.href };
}

export function createProvider(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? hostIdentity().appName },
		clientMetadataDocument:
			settings.clientRegistration === "cimd"
				? (metadata) => clientMetadataDocument(serverUrl, redirectUrl, metadata)
				: undefined,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		store,
		onRedirect,
	});
}
