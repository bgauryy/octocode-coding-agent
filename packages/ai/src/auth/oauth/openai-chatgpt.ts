/**
 * OpenAI Responses API token sharing through Sign in with ChatGPT.
 *
 * This public-client flow uses no client secret and sends the resulting user
 * access token directly to api.openai.com.
 */

import { randomBytes } from "node:crypto";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { chooseOpenAIAccount, logoutOpenAI, withOpenAIAccounts } from "./openai-accounts.ts";
import { generatePKCE } from "./pkce.ts";
import { validateOpenAIIdToken } from "./openai-id-token.ts";
import { requestVendorModels } from "../../providers/discovery.ts";

// First-time registration only; subsequent sign-ins reuse the selected account's issued ID.
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME_HINT = "Octocode";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_HOST = getProviderEnvValue("OCTOCODE_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh this long before the real expiry so a request never starts with a token about to expire.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

type AuthorizationResult = { code: string; clientId: string };

type TokenResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	id_token?: unknown;
	scope?: unknown;
};

function randomValue(): string {
	return randomBytes(32).toString("base64url");
}

function authorizationResult(url: URL, state: string, selectedClientId?: string): AuthorizationResult {
	if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
	const error = url.searchParams.get("error");
	if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
	const code = url.searchParams.get("code");
	if (!code) throw new Error("Missing authorization code");
	const returnedId = url.searchParams.get("client_id")?.trim();
	if (selectedClientId && returnedId && returnedId !== selectedClientId)
		throw new Error("ChatGPT client registration mismatch");
	const clientId = returnedId || selectedClientId;
	if (!clientId) throw new Error("OpenAI OAuth registration callback did not contain an issued client ID");
	if (!clientId.startsWith("oaiapp_")) throw new Error("Invalid OpenAI issued client ID");
	return { code, clientId };
}

function manualAuthorization(
	input: string,
	redirectUri: string,
	state: string,
	selectedClientId?: string,
): AuthorizationResult {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Paste the full callback URL from the browser");
	}
	const expected = new URL(redirectUri);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname)
		throw new Error(`The pasted callback URL must start with ${redirectUri}`);
	return authorizationResult(url, state, selectedClientId);
}

/** The RFC 6749 `error` code of a failed token response; other body fields are never surfaced. */
async function oauthErrorCode(response: Response): Promise<string | undefined> {
	try {
		const body: unknown = JSON.parse((await response.text()).slice(0, 4096));
		const code = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
		return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
	} catch {
		return undefined;
	}
}

async function requestToken(body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});
	if (!response.ok) {
		const code = await oauthErrorCode(response);
		const reason = code === "invalid_grant" ? "; the ChatGPT sign-in expired or was revoked" : "";
		throw new Error(`OpenAI OAuth token request failed (${response.status}${code ? ` ${code}` : ""})${reason}`);
	}
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error("OpenAI OAuth token response is not valid JSON");
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("OpenAI OAuth token response must be an object");
	}
	return data;
}

function requireTokenString(value: unknown, field: "access_token" | "refresh_token" | "scope"): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`OpenAI OAuth token response has invalid ${field}`);
	}
	return value;
}

function credentialFromTokenResponse(
	token: TokenResponse,
	clientId: string,
	previous?: OAuthCredential,
): OAuthCredential {
	const access = requireTokenString(token.access_token, "access_token");
	const refresh = requireTokenString(token.refresh_token ?? previous?.refresh, "refresh_token");
	const scope = requireTokenString(
		token.scope ?? (Array.isArray(previous?.scopes) ? previous.scopes.join(" ") : undefined),
		"scope",
	);
	if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
		throw new Error("OpenAI OAuth token response has invalid expires_in");
	}
	const scopes = scope.trim().split(/\s+/).filter(Boolean);
	if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
		throw new Error(`OpenAI OAuth grant did not include ${DIRECT_TOKEN_SCOPE}`);
	}
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + token.expires_in * 1000 - Math.min(EXPIRY_MARGIN_MS, token.expires_in * 100),
		clientId,
		scopes,
	};
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
	clientId: string,
	nonce: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
			resource: RESOURCE,
		}),
		signal,
	);
	const credential = credentialFromTokenResponse(token, clientId);
	const subject = await validateOpenAIIdToken(token.id_token, clientId, nonce, signal);
	return { ...credential, subject, idToken: token.id_token };
}

async function refreshAccessToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const clientId = credential.clientId;
	if (typeof clientId !== "string" || clientId.trim().length === 0) {
		throw new Error("Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT");
	}
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: credential.refresh,
			resource: RESOURCE,
		}),
		signal,
	);
	return withOpenAIAccounts({ ...credential, ...credentialFromTokenResponse(token, clientId, credential) }, credential);
}

/** OpenAI identifies each installation ("agent host") by a stable URI such as `urn:uuid:<uuid>`. */
function agentHostId(deviceId: string | undefined): string {
	if (!deviceId || !UUID_PATTERN.test(deviceId)) {
		throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation");
	}
	return `urn:uuid:${deviceId.toLowerCase()}`;
}

async function loginOpenAIChatGPT(
	interaction: ProviderAuthInteraction,
	options?: LoginOptions,
): Promise<OAuthCredential> {
	const hostId = agentHostId(options?.getDeviceId?.());
	interaction.signal.throwIfAborted();
	const selected = await chooseOpenAIAccount(interaction, options?.previousCredential);
	const { verifier, challenge } = await generatePKCE();
	const state = randomValue();
	const nonce = randomValue();
	const start = (port: number) =>
		startOAuthCallbackServer({
			providerName: "OpenAI",
			host: CALLBACK_HOST,
			redirectHost: "127.0.0.1",
			port,
			path: CALLBACK_PATH,
			state,
			signal: interaction.signal,
			timeoutMs: 5 * 60 * 1000,
			complete: async (_code, url) => authorizationResult(url, state, selected?.clientId),
		});
	const callback = await start(CALLBACK_PORT).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return start(0);
		throw error;
	});
	const redirectUri = callback.redirectUri;
	try {
		const authorizationUrl = new URL(AUTHORIZE_URL);
		authorizationUrl.search = new URLSearchParams({
			client_id: selected?.clientId ?? DYNAMIC_CLIENT_ID,
			...(!selected ? { agent_name_hint: options?.agentName ?? AGENT_NAME_HINT } : {}),
			ext_agent_host_id: hostId,
			response_type: "code",
			redirect_uri: redirectUri,
			resource: RESOURCE,
			scope: SCOPE,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			nonce,
			...(selected?.idToken ? { id_token_hint: selected.idToken } : {}),
		}).toString();
		interaction.notify({
			type: "auth_url",
			url: authorizationUrl.toString(),
			instructions: "Complete sign-in in your browser, or paste the final redirect URL here.",
		});
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the final redirect URL here:",
			placeholder: redirectUri,
		});
		const authorization =
			result.type === "callback"
				? result.value
				: manualAuthorization(result.input, redirectUri, state, selected?.clientId);
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const credential = await exchangeAuthorizationCode(
			authorization.code,
			verifier,
			redirectUri,
			authorization.clientId,
			nonce,
			interaction.signal,
		);
		if (selected && credential.subject !== selected.subject)
			throw new Error("ChatGPT account mismatch; choose another account to connect this identity");
		try {
			credential.availableModels = await requestVendorModels(
				{ id: "openai", baseUrl: RESOURCE, getModels: () => [] },
				{ apiKey: credential.access },
				{ signal: interaction.signal, chatGPT: true },
			);
		} catch {
			// Do not discard a newly issued renewable session after a discovery outage.
			credential.availableModels = [];
			interaction.notify({
				type: "info",
				message:
					"ChatGPT connected, but model discovery failed. Refresh the provider's model catalog before selecting a model.",
			});
		}
		return withOpenAIAccounts(credential, options?.previousCredential);
	} catch (error) {
		if (interaction.signal.aborted) throw new Error("Login cancelled", { cause: error });
		throw error;
	} finally {
		callback.close();
	}
}

export const openaiChatGPTOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT subscription)",
	isSubscription: true,
	loginLabel: "Sign in with ChatGPT",
	login: loginOpenAIChatGPT,
	refresh: refreshAccessToken,
	logout: logoutOpenAI,
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
