/** How a server connection authenticates: OAuth with stored credentials, a pi provider token, or neither. */

import { McpAuthRequiredError } from "@octocodeai/octocode-mcp";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@octocodeai/octocode-mcp/oauth";
import { resolveConfigValueOrThrow } from "../../../core/resolve-config-value.ts";
import type { McpServerEntry } from "../config.ts";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
} from "../oauth.ts";

export function signInRequiredMessage(entry: McpServerEntry): string {
	const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
	return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

/** Why a connection cannot be used now: disabled in its config, stopped in this session, or shut down. */
export function unavailableError(entry: McpServerEntry, stopped: boolean, closed: boolean): Error | undefined {
	if (entry.config.enabled === false) return new Error(`MCP server "${entry.name}" is disabled`);
	if (stopped)
		return new Error(`MCP server "${entry.name}" is stopped in this session; connect or restart it to use it`);
	if (closed) return new Error(`MCP server "${entry.name}" is shut down`);
	return undefined;
}

/** OAuth servers that still reject the request after a refresh need the user to sign in again. */
export function needsSignIn(error: unknown, authProvider: McpAuthProvider | undefined): boolean {
	return (
		error instanceof McpOAuthAuthorizationRequiredError ||
		(authProvider !== undefined && error instanceof McpAuthRequiredError)
	);
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header or `auth`. */
export function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config) || config.auth) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

export function mcpOAuthSettings(entry: McpServerEntry): McpOAuthSettings {
	const oauth = "url" in entry.config ? entry.config.oauth : undefined;
	if (!oauth) return {};
	return {
		clientId: oauth.clientId,
		clientSecret:
			oauth.clientSecret === undefined
				? undefined
				: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${entry.name}" oauth.clientSecret`),
		callbackPort: oauth.callbackPort,
		callbackUrl: oauth.callbackUrl,
		scope: oauth.scope,
		clientName: oauth.clientName,
		clientRegistration: oauth.clientRegistration,
		authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
	};
}

/** The auth provider of a connection: OAuth when `oauthUrl` is set, else the `auth.provider` token, if any. */
export function createConnectionAuthProvider(options: {
	entry: McpServerEntry;
	oauthUrl: string | undefined;
	credentials: McpOAuthCredentialStore;
	providerToken: ((provider: string) => Promise<string | undefined>) | undefined;
	settings: () => McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider | undefined {
	const { entry, oauthUrl: url } = options;
	const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
	return url
		? createMcpAuthProvider({
				serverUrl: url,
				store: options.credentials.forServer(entry.name, url),
				settings: options.settings,
				onChallenge: options.onChallenge,
			})
		: provider
			? // Read on every request, so the provider's refreshes apply; MCP stores no copy.
				{ token: async () => options.providerToken?.(provider), settled: async () => {} }
			: undefined;
}
