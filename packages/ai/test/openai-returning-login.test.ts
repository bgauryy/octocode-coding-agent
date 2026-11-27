import { afterEach, expect, it, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { openAIJwks, signedOpenAIIdToken } from "./openai-id-token-fixtures.ts";

// Test the returning-account protocol independently of OS loopback binding.
vi.mock("../src/auth/oauth/callback-server.ts", () => ({
	startOAuthCallbackServer: async () => ({ redirectUri: "http://127.0.0.1:1455/auth/callback", close: () => {} }),
	waitForCallbackOrManualInput: async (interaction: { prompt: (prompt: unknown) => Promise<string> }) => ({
		type: "manual",
		input: await interaction.prompt({ type: "manual_code" }),
	}),
}));

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("reuses a saved registration and rejects an account mismatch: %s", async (mismatch) => {
	let authorize: URL | undefined;
	const previous: OAuthCredential = {
		type: "oauth",
		access: "previous-access",
		refresh: "previous-refresh",
		expires: 0,
		clientId: "oaiapp_saved",
		subject: "saved-account",
		idToken: "previous-id-token",
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url, init) => {
			if (String(url).endsWith("jwks.json")) return Response.json(openAIJwks);
			if (String(url).endsWith("/models")) return Response.json({ models: [] });
			const body = new URLSearchParams(init?.body);
			expect(body.get("client_id")).toBe("oaiapp_saved");
			expect(body.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
			return Response.json({
				access_token: "access",
				refresh_token: "refresh",
				expires_in: 3600,
				scope: "chatgpt.tokens.use.direct",
				id_token: signedOpenAIIdToken(authorize?.searchParams.get("nonce") ?? "", {
					aud: "oaiapp_saved",
					sub: mismatch ? "another-account" : "saved-account",
				}),
			});
		}),
	);
	const operation = openaiChatGPTOAuth.login(
		{
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "auth_url") authorize = new URL(event.url);
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "0";
				expect(authorize?.searchParams.get("client_id")).toBe("oaiapp_saved");
				expect(authorize?.searchParams.has("agent_name_hint")).toBe(false);
				expect(authorize?.searchParams.get("id_token_hint")).toBe("previous-id-token");
				const callback = new URL("http://127.0.0.1:1455/auth/callback");
				callback.search = new URLSearchParams({
					code: "code",
					state: authorize?.searchParams.get("state") ?? "",
				}).toString();
				return callback.toString();
			},
		},
		{ previousCredential: previous, getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305" },
	);
	if (mismatch) await expect(operation).rejects.toThrow("account mismatch");
	else await expect(operation).resolves.toMatchObject({ clientId: "oaiapp_saved", subject: "saved-account" });
});

it("redacts invalid JSON token responses during refresh", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("secret-token-invalid-json")),
	);
	await expect(
		openaiChatGPTOAuth.refresh(
			{
				type: "oauth",
				access: "old",
				refresh: "refresh",
				expires: 0,
				clientId: "oaiapp_saved",
			},
			new AbortController().signal,
		),
	).rejects.toThrow("OpenAI OAuth token response is not valid JSON");
});
