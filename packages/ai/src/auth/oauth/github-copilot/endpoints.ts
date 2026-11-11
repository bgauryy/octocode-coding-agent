/** GitHub and Copilot endpoints, client identity and request helpers shared by the OAuth flow. */

import { getProviderEnvValue } from "../../../utils/provider-env.ts";
import { getUserAgent } from "../../../utils/user-agent.ts";

const decode = (s: string) => atob(s);
/** The VS Code Copilot Chat client, used while no Octocode GitHub OAuth app is configured. */
export const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

/** Names the client ID of a GitHub OAuth app registered for Octocode; when set, sign-in identifies as Octocode. */
const COPILOT_CLIENT_ID_ENV = "OCTOCODE_COPILOT_CLIENT_ID";

/** The configured Octocode GitHub OAuth app, or undefined to keep the VS Code client. */
export function octocodeCopilotClientId(): string | undefined {
	return getProviderEnvValue(COPILOT_CLIENT_ID_ENV)?.trim() || undefined;
}

export const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;
export const COPILOT_API_VERSION = "2026-06-01";
const COPILOT_USER_API_VERSION = "2025-04-01";

/** Shown before every Copilot sign-in. */
export const COPILOT_SIGN_IN_NOTICE =
	"GitHub officially supports Copilot subscriptions in third-party agents only for OpenCode, through a partnership. Octocode is not part of it, and GitHub's terms and Acceptable Use Policies apply to this sign-in.";

/**
 * Octocode's own identity on Copilot requests, as OpenCode sends it: an honest User-Agent and the API version, with
 * no editor or integration headers.
 */
export function octocodeCopilotHeaders(): Record<string, string> {
	return { "User-Agent": getUserAgent(), "X-GitHub-Api-Version": COPILOT_API_VERSION };
}

/**
 * The GitHub tokens of credentials signed in through an Octocode GitHub app, recorded when their request auth is
 * derived (`toAuth`). The request identity follows the credential, never a header a user configured.
 */
const octocodeAppTokens = new Set<string>();

export function markOctocodeAppToken(token: string): void {
	octocodeAppTokens.add(token);
}

export function isOctocodeAppToken(token: string | undefined): boolean {
	return token !== undefined && octocodeAppTokens.has(token);
}

/** The editor identity headers the VS Code client sends and the Octocode identity drops. */
export const VSCODE_IDENTITY_HEADERS = Object.keys(COPILOT_HEADERS).filter((name) => name !== "User-Agent");

/** GitHub's Copilot entitlement endpoint for a domain. */
export function copilotUserUrl(domain: string): string {
	return domain === "github.com"
		? "https://api.github.com/copilot_internal/user"
		: `https://api.${domain}/copilot_internal/user`;
}

/** Headers for the entitlement lookup with a GitHub OAuth token. */
export function copilotUserHeaders(githubToken: string): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${githubToken}`,
		"User-Agent": getUserAgent(),
		"X-GitHub-Api-Version": COPILOT_USER_API_VERSION,
	};
}

/** The Copilot API for a GitHub OAuth token used directly, when the entitlement lookup names no endpoint. */
export function octocodeCopilotBaseUrl(enterpriseDomain?: string): string {
	return enterpriseDomain ? `https://copilot-api.${enterpriseDomain}` : "https://api.githubcopilot.com";
}

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

export function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
	copilotTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * Returns API URL like https://api.individual.githubcopilot.com
 */
function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	const proxyHost = match[1];
	// Convert proxy.xxx to api.xxx
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	// If we have a token, extract the base URL from proxy-ep
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	// Fallback for enterprise or if token parsing fails
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`GitHub Copilot authentication request failed (HTTP ${response.status})`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error("GitHub Copilot authentication response is not valid JSON");
	}
}
