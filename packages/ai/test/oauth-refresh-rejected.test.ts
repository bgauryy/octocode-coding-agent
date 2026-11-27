import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { refreshStoredOAuthCredential, resolveProviderAuth } from "../src/auth/resolve.ts";
import type { AuthContext, OAuthAuth, OAuthCredential } from "../src/auth/types.ts";

const authContext: AuthContext = { env: async () => undefined, fileExists: async () => false };

function expired(refresh = "dead-refresh"): OAuthCredential {
	return { type: "oauth", access: "old-access", refresh, expires: 0 };
}

function oauthWith(refresh: OAuthAuth["refresh"]): OAuthAuth {
	return {
		name: "Test OAuth",
		login: async () => {
			throw new Error("not used");
		},
		refresh,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
}

async function storeWith(credential: OAuthCredential): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("p1", async () => credential);
	return store;
}

const getAuth = (store: InMemoryCredentialStore, oauth: OAuthAuth) =>
	resolveProviderAuth({ id: "p1", auth: { oauth } }, store, authContext);

describe("rejected OAuth refresh tokens", () => {
	it.each([
		["OAuth invalid_grant", "OpenAI OAuth token request failed (400 invalid_grant); the ChatGPT sign-in expired"],
		["xAI invalid_grant", "xAI OAuth token refresh failed (HTTP 400): invalid_grant: token revoked"],
		["Kimi unauthorized", "Kimi Code token refresh unauthorized (status 401): revoked"],
	])("%s: sends the refresh once, then fails the same way without a request", async (_name, reason) => {
		const refresh = vi.fn(async () => {
			throw new Error(reason);
		});
		const oauth = oauthWith(refresh);
		const store = await storeWith(expired());

		const first = await getAuth(store, oauth).catch((error: unknown) => error);
		expect(first).toMatchObject({ code: "oauth" });
		expect((first as Error).message).toContain("OAuth refresh failed for p1");
		expect((first as Error).message).toContain(reason);

		const later = await Promise.all([1, 2, 3].map(() => getAuth(store, oauth).catch((error: unknown) => error)));
		for (const error of later) {
			expect(error).toMatchObject({ code: "oauth" });
			const { message } = error as Error;
			expect(message).toMatch(/^OAuth refresh failed for p1: the provider rejected this sign-in/);
			expect(message).toContain("sign in again");
		}
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("persists the refusal with a hash of the token, never the token", async () => {
		const oauth = oauthWith(async () => {
			throw new Error("400 invalid_grant");
		});
		const store = await storeWith(expired("secret-refresh-token"));
		await expect(getAuth(store, oauth)).rejects.toThrow("invalid_grant");

		const stored = (await store.read("p1")) as OAuthCredential;
		expect(stored).toMatchObject({ access: "old-access", refresh: "secret-refresh-token", expires: 0 });
		expect(stored.refreshRejected?.at).toBeTypeOf("number");
		expect(stored.refreshRejected?.refreshSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(stored.refreshRejected)).not.toContain("secret-refresh-token");
	});

	it.each([
		["network", new TypeError("fetch failed")],
		["timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
		["5xx", new Error("OpenAI OAuth token request failed (503)")],
		["rate limit", new Error("Kimi Code token refresh failed with status 429")],
		["abort", new DOMException("This operation was aborted", "AbortError")],
	])("%s failure persists nothing and is retried on every request", async (_name, failure) => {
		const refresh = vi.fn(async () => {
			throw failure;
		});
		const oauth = oauthWith(refresh);
		const original = expired();
		const store = await storeWith(original);

		for (let i = 0; i < 4; i++) {
			await expect(getAuth(store, oauth)).rejects.toMatchObject({ code: "oauth" });
		}
		expect(refresh).toHaveBeenCalledTimes(4);
		expect(await store.read("p1")).toEqual(original);
	});

	it("a new sign-in replaces the credential, clears the marker and resolves again", async () => {
		const refresh = vi.fn(async () => {
			throw new Error("400 invalid_grant");
		});
		const oauth = oauthWith(refresh);
		const store = await storeWith(expired());
		await expect(getAuth(store, oauth)).rejects.toThrow("invalid_grant");
		await expect(getAuth(store, oauth)).rejects.toThrow("sign in again");
		expect(refresh).toHaveBeenCalledTimes(1);

		const signedIn: OAuthCredential = {
			type: "oauth",
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 3600_000,
		};
		await store.modify("p1", async () => signedIn);
		expect((await store.read("p1")) as OAuthCredential).not.toHaveProperty("refreshRejected");
		expect(await getAuth(store, oauth)).toEqual({ auth: { apiKey: "new-access" }, source: "OAuth" });
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("retries when the refresh token changed but a stale marker was copied along", async () => {
		const refresh = vi.fn(async (credential: OAuthCredential) => ({
			...credential,
			access: "renewed",
			expires: Date.now() + 3600_000,
		}));
		const oauth = oauthWith(refresh);
		const store = await storeWith({
			...expired("rotated-refresh"),
			refreshRejected: { at: 1, refreshSha256: "0".repeat(64) },
		});

		expect(await getAuth(store, oauth)).toEqual({ auth: { apiKey: "renewed" }, source: "OAuth" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect((await store.read("p1")) as OAuthCredential).not.toHaveProperty("refreshRejected");
	});

	it("does not consult the marker while the access token is still valid", async () => {
		const refresh = vi.fn();
		const oauth = oauthWith(refresh);
		const store = await storeWith({
			...expired(),
			expires: Date.now() + 3600_000,
			refreshRejected: { at: 1, refreshSha256: "0".repeat(64) },
		});

		expect(await getAuth(store, oauth)).toEqual({ auth: { apiKey: "old-access" }, source: "OAuth" });
		expect(refresh).not.toHaveBeenCalled();
	});

	it("keeps lock-wait cancellation: an aborted caller does not run the refresh", async () => {
		const refresh = vi.fn(async (credential: OAuthCredential) => credential);
		const oauth = oauthWith(refresh);
		const store = await storeWith(expired());
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		await expect(refreshStoredOAuthCredential(store, "p1", oauth, () => true, controller.signal)).rejects.toThrow(
			"cancelled",
		);
		expect(refresh).not.toHaveBeenCalled();
	});
});
