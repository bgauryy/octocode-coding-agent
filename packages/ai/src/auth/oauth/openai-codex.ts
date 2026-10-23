/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http (via callback-server.ts) for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
// oxlint-disable-next-line typescript/consistent-type-imports -- import() type keeps node:crypto out of browser bundles
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	void import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
}

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput, parseAuthorizationInput } from "./callback-server.ts";
import { loginOpenAICodexDeviceCode } from "./openai-codex/device-auth.ts";
import {
	AUTH_BASE_URL,
	CLIENT_ID,
	credentialsFromToken,
	exchangeAuthorizationCodeForCredentials,
	refreshAccessToken,
} from "./openai-codex/tokens.ts";
import { generatePKCE } from "./pkce.ts";

const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_BROWSER_LOGIN_METHOD = "browser";
const OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code";
const SCOPE = "openid profile email offline_access";

function getCallbackHost(): string {
	return getProviderEnvValue("OCTOCODE_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

function createState(): string {
	if (!_randomBytes) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	return _randomBytes(16).toString("hex");
}

async function createAuthorizationFlow(
	originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", originator);

	return { verifier, state, url: url.toString() };
}

async function loginOpenAICodex(
	interaction: ProviderAuthInteraction,
	options?: LoginOptions,
): Promise<OAuthCredential> {
	const { verifier, state, url } = await createAuthorizationFlow(options?.agentName);
	// Port 1455 is shared with the Codex CLI; when it is taken, fall back to the pasted redirect URL.
	const callback = await startOAuthCallbackServer({
		providerName: "OpenAI",
		host: getCallbackHost(),
		port: 1455,
		path: "/auth/callback",
		state,
		complete: async (code) => code,
		signal: interaction.signal,
	}).catch(() => undefined);

	interaction.notify({
		type: "auth_url",
		url,
		instructions: "A browser window should open. Complete login to finish.",
	});

	try {
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: REDIRECT_URI,
		});
		let code: string | undefined;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
			code = parsed.code;
		}

		if (!code) throw new Error("Missing authorization code");
		return await exchangeAuthorizationCodeForCredentials(code, verifier, REDIRECT_URI, interaction.signal);
	} finally {
		callback?.close();
	}
}

/**
 * Refresh OpenAI Codex OAuth token
 */
async function refreshOpenAICodexToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	return credentialsFromToken(await refreshAccessToken(refreshToken, signal));
}

export const openaiCodexOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT Plus/Pro)",
	isSubscription: true,

	async login(interaction, options) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select OpenAI Codex login method:",
			options: [
				{ id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD, label: "Device code login (headless)" },
			],
		});

		if (method === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD) {
			return loginOpenAICodexDeviceCode(interaction);
		}
		if (method !== OPENAI_CODEX_BROWSER_LOGIN_METHOD) {
			throw new Error(`Unknown OpenAI Codex login method: ${method}`);
		}

		return loginOpenAICodex(interaction, options);
	},

	refresh: (credential, signal) => refreshOpenAICodexToken(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
