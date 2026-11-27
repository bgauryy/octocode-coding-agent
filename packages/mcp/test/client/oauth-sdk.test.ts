import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	adaptOAuthProvider,
	authorizeMcp,
	discoverAuthorizationServerMetadata,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	MemoryOAuthStateStore,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	type OAuthClientMetadataDocument,
	type OAuthTokens,
} from "../../src/client/oauth/index.ts";
import type { McpFetch } from "../../src/client/auth-provider.ts";

const origin = "https://auth.example";
const serverUrl = `${origin}/mcp`;
const metadata = {
	issuer: origin,
	authorization_endpoint: `${origin}/authorize`,
	token_endpoint: `${origin}/token`,
	registration_endpoint: `${origin}/register`,
	response_types_supported: ["code"],
	code_challenge_methods_supported: ["S256"],
};

function fixture(options: { document?: OAuthClientMetadataDocument } = {}) {
	const store = new MemoryOAuthStateStore();
	const urls: URL[] = [];
	const calls: { url: string; init: RequestInit }[] = [];
	const grants: URLSearchParams[] = [];
	let refresh = 0;
	const provider = new McpOAuthProvider({
		serverUrl,
		redirectUrl: "http://127.0.0.1/callback",
		clientMetadata: { client_name: "test" },
		clientMetadataDocument: options.document ? () => options.document : undefined,
		store,
		onRedirect: (url) => {
			urls.push(url);
		},
	});
	const fetch: McpFetch = async (input, init) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		if (url.includes("oauth-protected-resource")) {
			return Response.json({ resource: serverUrl, authorization_servers: [origin], scopes_supported: ["repo"] });
		}
		if (url.includes("oauth-authorization-server")) return Response.json(metadata);
		if (url.endsWith("/register")) {
			return Response.json({ ...JSON.parse(String(init?.body)), client_id: "client", client_secret: "" });
		}
		if (url.endsWith("/token")) {
			const params = new URLSearchParams(String(init?.body));
			grants.push(params);
			if (params.get("grant_type") === "refresh_token") {
				refresh++;
				return Response.json({
					access_token: `refreshed-${refresh}`,
					token_type: "Bearer",
					refresh_token: "",
					expires_in: null,
				});
			}
			return Response.json({
				access_token: "first",
				refresh_token: "refresh",
				token_type: "Bearer",
				scope: "",
				id_token: null,
			});
		}
		return new Response(null, { status: 404 });
	};
	return { store, urls, calls, grants, provider, fetch };
}

describe("official MCP OAuth SDK integration", () => {
	it("registers, exchanges and refreshes with PKCE, issuer binding and compatible optional fields", async () => {
		const { provider, store, urls, calls, grants, fetch } = fixture();
		expect(await authorizeMcp(provider, { serverUrl, fetch })).toBe("REDIRECT");
		const state = store.load()!;
		expect(urls[0].searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(state.codeVerifier!).digest("base64url"),
		);
		expect(urls[0].searchParams.get("code_challenge_method")).toBe("S256");
		expect(urls[0].searchParams.get("scope")).toBe("repo");
		expect(JSON.parse(String(calls.find(({ url }) => url.endsWith("/register"))!.init.body))).toMatchObject({
			application_type: "native",
		});
		expect(await authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code", iss: origin })).toBe(
			"AUTHORIZED",
		);
		expect(store.load()?.tokens).toEqual({
			access_token: "first",
			refresh_token: "refresh",
			token_type: "Bearer",
			scope: "repo",
			issuer: origin,
		});
		expect(await authorizeMcp(provider, { serverUrl, fetch })).toBe("AUTHORIZED");
		expect(store.load()?.tokens).toEqual({
			access_token: "refreshed-1",
			refresh_token: "refresh",
			token_type: "Bearer",
			scope: "repo",
			issuer: origin,
		});
		expect(grants.map((grant) => grant.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
		expect(grants[0].get("code_verifier")).toBe(state.codeVerifier);
		expect(grants.every((grant) => grant.get("resource") === serverUrl)).toBe(true);
		expect(calls.every(({ init }) => init.credentials === "omit")).toBe(true);
	});

	it("preserves document-selected client IDs and callback paths without storing a registration", async () => {
		const document = { url: "https://client.example/client.json", redirectUrl: "http://127.0.0.1/callback/server" };
		const { provider, store, urls, grants, fetch, calls } = fixture({ document });
		await authorizeMcp(provider, { serverUrl, fetch });
		expect(urls[0].searchParams.get("redirect_uri")).toBe(document.redirectUrl);
		expect(urls[0].searchParams.get("client_id")).toBe(document.url);
		await authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code" });
		expect(grants[0].get("redirect_uri")).toBe(document.redirectUrl);
		expect(grants[0].get("client_id")).toBe(document.url);
		expect(store.load()?.clientInformation).toBeUndefined();
		expect(calls.some(({ url }) => url.endsWith("/register"))).toBe(false);
	});

	it("rejects mismatched callback and discovery issuers before sending credentials", async () => {
		const { provider, fetch, grants } = fixture();
		await authorizeMcp(provider, { serverUrl, fetch });
		await expect(
			authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code", iss: "https://attacker.example" }),
		).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
		expect(grants).toHaveLength(0);
		await expect(
			discoverAuthorizationServerMetadata(origin, {
				fetch: async () => Response.json({ ...metadata, issuer: "https://attacker.example" }),
			}),
		).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
	});

	it("retains explicit metadata overrides and rejects insecure override URLs", async () => {
		const f = fixture();
		const options = { serverUrl, authorizationServerMetadataUrl: new URL(`${origin}/metadata.json`) };
		const fetch: McpFetch = async (url, init) =>
			String(url).endsWith("/metadata.json")
				? Response.json({ ...metadata, issuer: "https://configured.example" })
				: f.fetch(url, init);
		await authorizeMcp(f.provider, { ...options, fetch });
		expect(f.urls[0].origin).toBe(origin);
		await expect(
			authorizeMcp(f.provider, {
				...options,
				fetch,
				authorizationServerMetadataUrl: new URL("http://public.example/metadata.json"),
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
	});

	it("shares refreshes and keeps granted scopes during a step-up", async () => {
		const { provider, fetch, grants, urls } = fixture();
		await authorizeMcp(provider, { serverUrl, fetch });
		await authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code" });
		const auth = adaptOAuthProvider(provider);
		const context = {
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(serverUrl),
			fetch,
			token: "first",
		};
		await Promise.all([auth.onUnauthorized!(context), auth.onUnauthorized!(context)]);
		expect(grants.filter((grant) => grant.get("grant_type") === "refresh_token")).toHaveLength(1);
		await expect(
			auth.onUnauthorized!({
				...context,
				response: new Response(null, {
					status: 403,
					headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin"' },
				}),
			}),
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		expect(urls.at(-1)?.searchParams.get("scope")).toBe("repo admin");
	});

	it("stops a refresh without redirecting even when injected fetch ignores cancellation", async () => {
		const { provider, fetch, urls } = fixture();
		await authorizeMcp(provider, { serverUrl, fetch });
		await authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code" });
		const controller = new AbortController();
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const stalled: McpFetch = async () => {
			began();
			return new Promise<Response>(() => {});
		};
		const result = authorizeMcp(provider, { serverUrl, fetch: stalled, signal: controller.signal });
		const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
		await started;
		controller.abort();
		await rejected;
		expect(urls).toHaveLength(1);
	});

	it("does not send a stored refresh token to a different issuer", async () => {
		const { provider, fetch, grants } = fixture();
		await provider.saveTokens({
			access_token: "foreign",
			refresh_token: "private",
			token_type: "Bearer",
			issuer: "https://other.example",
		} satisfies OAuthTokens);
		expect(await authorizeMcp(provider, { serverUrl, fetch })).toBe("REDIRECT");
		expect(grants).toHaveLength(0);
	});

	it("does not renew an old token's expiry when the SDK stamps its issuer", async () => {
		const { provider, store } = fixture();
		const now = vi.spyOn(Date, "now");
		try {
			now.mockReturnValue(1_000);
			const tokens = { access_token: "old", token_type: "Bearer", expires_in: 60 };
			await provider.saveTokens(tokens);
			now.mockReturnValue(50_000);
			await provider.saveTokens({ ...tokens, issuer: origin });
			expect(store.load()?.tokensExpireAt).toBe(61_000);
			await provider.saveTokens({ ...tokens, access_token: "new", issuer: origin });
			expect(store.load()?.tokensExpireAt).toBe(110_000);
		} finally {
			now.mockRestore();
		}
	});

	it("recovers an invalid refresh grant through SDK credential invalidation", async () => {
		const { provider, fetch, store, urls } = fixture();
		await authorizeMcp(provider, { serverUrl, fetch });
		await authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code" });
		let failures = 0;
		const invalidGrant: McpFetch = async (url, init) => {
			if (String(url).endsWith("/token")) {
				failures++;
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			return fetch(url, init);
		};
		expect(await authorizeMcp(provider, { serverUrl, fetch: invalidGrant })).toBe("REDIRECT");
		expect(failures).toBe(1);
		expect(store.load()?.tokens).toBeUndefined();
		expect(urls).toHaveLength(2);
	});

	it("does not register or redirect after discovery is cancelled", async () => {
		const { provider, store, urls } = fixture();
		const controller = new AbortController();
		const fetch: McpFetch = async () => {
			controller.abort();
			return new Response(null, { status: 404 });
		};
		await expect(authorizeMcp(provider, { serverUrl, fetch, signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(store.load()).toBeUndefined();
		expect(urls).toHaveLength(0);
	});

	it("rejects an insecure token endpoint before sending a refresh token", async () => {
		const { provider, fetch, store, grants } = fixture();
		await authorizeMcp(provider, { serverUrl, fetch });
		await authorizeMcp(provider, { serverUrl, fetch, authorizationCode: "code" });
		const state = store.load()!;
		state.discovery!.authorizationServerMetadata!.token_endpoint = "http://public.example/token";
		store.save(state);
		await expect(authorizeMcp(provider, { serverUrl, fetch })).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		expect(grants).toHaveLength(1);
	});
});
