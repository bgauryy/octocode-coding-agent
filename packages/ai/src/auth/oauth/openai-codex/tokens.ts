import { decodeJwt as decodeJoseJwt } from "jose";
import type { OAuthCredential } from "../../types.ts";
import { parseOAuthTokenResponse } from "../token-response.ts";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_BASE_URL = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type OAuthToken = { access: string; refresh: string; expires: number };
type TokenOperation = "exchange" | "refresh";

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

function decodeJwt(token: string): JwtPayload | null {
	try {
		// Account routing metadata only; this does not authenticate the token.
		return decodeJoseJwt(token) as JwtPayload;
	} catch {
		return null;
	}
}

export async function fetchWithLoginCancellation(input: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(input, {
			...init,
			redirect: "error",
			signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
		});
	} catch (error) {
		if (init.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}
}

async function readTokenResponse(response: Response, operation: TokenOperation): Promise<OAuthToken> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`OpenAI Codex token ${operation} failed (${response.status})`);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("OpenAI Codex token response is not valid JSON");
	}
	return parseOAuthTokenResponse(body, "OpenAI Codex");
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthToken> {
	const response = await fetchWithLoginCancellation(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal,
	});

	return readTokenResponse(response, "exchange");
}

export async function refreshAccessToken(refreshToken: string, signal: AbortSignal): Promise<OAuthToken> {
	let response: Response;
	try {
		response = await fetchWithLoginCancellation(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
			signal,
		});
	} catch (error) {
		throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
	}

	return readTokenResponse(response, "refresh");
}

function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

export function credentialsFromToken(token: OAuthToken): OAuthCredential {
	const accountId = getAccountId(token.access);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		type: "oauth",
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		accountId,
	};
}

export async function exchangeAuthorizationCodeForCredentials(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, redirectUri, signal));
}
