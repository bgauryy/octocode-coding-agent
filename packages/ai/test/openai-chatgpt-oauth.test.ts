import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { openAIJwks, signedOpenAIIdToken } from "./openai-id-token-fixtures.ts";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const neverAbortedSignal = new AbortController().signal;
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";
const nativeFetch = globalThis.fetch;
let authorizationNonce = "";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenResponse(scope = REQUIRED_SCOPE) {
	return {
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 3600,
		id_token: "id-token",
		scope,
	};
}

function stubTokenEndpoint(response: unknown, inspect?: (body: URLSearchParams) => void) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input) === "https://api.openai.com/v1/models")
			return jsonResponse({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT", visibility: "list" }] });
		if (String(input) === "https://auth.openai.com/.well-known/jwks.json") return jsonResponse(openAIJwks);
		expect(input instanceof Request ? input.url : String(input)).toBe(TOKEN_URL);
		inspect?.(new URLSearchParams(String(init?.body)));
		return jsonResponse(
			typeof response === "object" && response !== null && "id_token" in response && response.id_token === "id-token"
				? { ...response, id_token: signedOpenAIIdToken(authorizationNonce) }
				: response,
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function loginInteraction(options?: {
	callbackClientId?: string;
	onAuthorize?: (url: URL) => void;
}): ProviderAuthInteraction {
	let authorizeUrl: URL | undefined;
	return {
		signal: neverAbortedSignal,
		notify: (event) => {
			if (event.type !== "auth_url") return;
			authorizeUrl = new URL(event.url);
			authorizationNonce = authorizeUrl.searchParams.get("nonce") ?? "";
			options?.onAuthorize?.(authorizeUrl);
		},
		prompt: async (prompt) => {
			if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
			if (!authorizeUrl) throw new Error("Authorization URL was not emitted before the callback prompt");
			const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("code", "authorization-code");
			callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
			if (options?.callbackClientId) callback.searchParams.set("client_id", options.callbackClientId);
			return callback.toString();
		},
	};
}

function connectedCredential(): OAuthCredential {
	return {
		type: "oauth",
		access: "old-access",
		refresh: "old-refresh",
		expires: 0,
		clientId: "oaiapp_existing",
		subject: "user-1",
		scopes: REQUIRED_SCOPE.split(" "),
	};
}

describe("OpenAI ChatGPT OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("registers a user-owned client and stores its issued ID and granted scopes", async () => {
		let authorizeUrl: URL | undefined;
		let exchangeBody: URLSearchParams | undefined;
		stubTokenEndpoint(tokenResponse(), (body) => {
			exchangeBody = body;
		});

		const credential = await openaiChatGPTOAuth.login(
			loginInteraction({
				callbackClientId: "oaiapp_issued",
				onAuthorize: (url) => {
					authorizeUrl = url;
				},
			}),
			{ getDeviceId: () => DEVICE_ID },
		);

		expect(authorizeUrl?.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(authorizeUrl?.searchParams.get("agent_name_hint")).toBe("Octocode");
		expect(authorizeUrl?.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${DEVICE_ID}`);
		expect(authorizeUrl?.searchParams.get("scope")).toBe(REQUIRED_SCOPE);
		expect(authorizeUrl?.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
		expect(authorizeUrl?.searchParams.get("resource")).toBe("https://api.openai.com/v1");
		expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
		expect(exchangeBody?.get("client_id")).toBe("oaiapp_issued");
		expect(exchangeBody?.get("code")).toBe("authorization-code");
		expect(exchangeBody?.get("resource")).toBe("https://api.openai.com/v1");
		expect(exchangeBody?.get("code_verifier")).toBeTruthy();
		expect(credential).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			clientId: "oaiapp_issued",
			subject: "test-subject",
			scopes: REQUIRED_SCOPE.split(" "),
		});
	});

	it("uses the app's agent name as the name hint", async () => {
		let authorizeUrl: URL | undefined;
		stubTokenEndpoint(tokenResponse());

		await openaiChatGPTOAuth.login(
			loginInteraction({
				callbackClientId: "oaiapp_issued",
				onAuthorize: (url) => {
					authorizeUrl = url;
				},
			}),
			{ getDeviceId: () => DEVICE_ID, agentName: "my-app" },
		);

		expect(authorizeUrl?.searchParams.get("agent_name_hint")).toBe("my-app");
	});

	it("rejects registration without an issued client ID", async () => {
		const fetchMock = stubTokenEndpoint(tokenResponse());

		await expect(openaiChatGPTOAuth.login(loginInteraction(), { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
			"registration callback did not contain an issued client ID",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a token response that did not grant direct token use", async () => {
		stubTokenEndpoint(tokenResponse("openid profile email offline_access resource.invoke"));

		await expect(
			openaiChatGPTOAuth.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), {
				getDeviceId: () => DEVICE_ID,
			}),
		).rejects.toThrow("grant did not include chatgpt.tokens.use.direct");
	});

	it("requires a device ID before starting authorization", async () => {
		let authorizationStarted = false;
		const interaction = loginInteraction({
			onAuthorize: () => {
				authorizationStarted = true;
			},
		});

		await expect(openaiChatGPTOAuth.login(interaction)).rejects.toThrow("requires a device ID");
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => "not-a-uuid" })).rejects.toThrow(
			"requires a device ID",
		);
		expect(authorizationStarted).toBe(false);
	});

	it("ignores an error callback from a different authorization attempt", async () => {
		stubTokenEndpoint(tokenResponse());
		const base = loginInteraction({ callbackClientId: "oaiapp_issued" });
		const interaction: ProviderAuthInteraction = {
			...base,
			prompt: async (prompt) => {
				const wrong = await nativeFetch("http://127.0.0.1:1455/auth/callback?error=access_denied&state=wrong");
				expect(wrong.status).toBe(400);
				await wrong.text();
				return base.prompt(prompt);
			},
		};
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID })).resolves.toMatchObject({
			subject: "test-subject",
		});
	});

	it("cancels login even when a manual prompt ignores its abort signal", async () => {
		const controller = new AbortController();
		const interaction: ProviderAuthInteraction = {
			signal: controller.signal,
			notify: () => {},
			prompt: () => {
				controller.abort();
				return new Promise(() => {});
			},
		};
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
			"Login cancelled",
		);
	});

	it("names the OAuth error code of a rejected refresh and never other body fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "invalid_grant", error_description: "token old-refresh reused" }), {
						status: 400,
					}),
			),
		);

		const failure = openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal);
		await expect(failure).rejects.toThrow(
			"OpenAI OAuth token request failed (400 invalid_grant); the ChatGPT sign-in expired or was revoked",
		);
		await expect(failure).rejects.not.toThrow("old-refresh");
	});

	it("keeps the status alone when a rejected token response has no OAuth error code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })),
		);

		await expect(openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal)).rejects.toThrow(
			/^OpenAI OAuth token request failed \(502\)$/,
		);
	});

	it("preserves the refresh token when a refresh response does not rotate it", async () => {
		const { refresh_token: _refreshToken, ...responseWithoutRefresh } = tokenResponse();
		stubTokenEndpoint(responseWithoutRefresh);

		await expect(openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal)).resolves.toMatchObject({
			refresh: "old-refresh",
		});
	});

	it("refreshes with the credential's issued client ID and stores replacement scopes", async () => {
		let refreshBody: URLSearchParams | undefined;
		stubTokenEndpoint({ ...tokenResponse(), access_token: "new-access", refresh_token: "new-refresh" }, (body) => {
			refreshBody = body;
		});

		const before = Date.now();
		const credential = await openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal);

		// expires_in is 3600 seconds; the credential expires 3 minutes early so it is refreshed in time.
		expect(credential.expires).toBeGreaterThanOrEqual(before + (3600 - 180) * 1000);
		expect(credential.expires).toBeLessThanOrEqual(Date.now() + (3600 - 180) * 1000);

		expect(refreshBody?.get("grant_type")).toBe("refresh_token");
		expect(refreshBody?.get("client_id")).toBe("oaiapp_existing");
		expect(refreshBody?.get("refresh_token")).toBe("old-refresh");
		expect(refreshBody?.get("resource")).toBe("https://api.openai.com/v1");
		expect(refreshBody?.has("scope")).toBe(false);
		expect(credential).toMatchObject({
			access: "new-access",
			refresh: "new-refresh",
			clientId: "oaiapp_existing",
			scopes: REQUIRED_SCOPE.split(" "),
		});
	});
});
