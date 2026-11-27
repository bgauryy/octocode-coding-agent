import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { refreshStoredOAuthCredential } from "../src/auth/resolve.ts";
import { chooseOpenAIAccount, openAIAccounts, withOpenAIAccounts } from "../src/auth/oauth/openai-accounts.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";

function credential(subject = "account-a", clientId = "oaiapp_a"): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${subject}`,
		refresh: `refresh-${subject}`,
		expires: Date.now() + 3600_000,
		subject,
		clientId,
		idToken: `identity-${subject}`,
		scopes: ["chatgpt.tokens.use.direct"],
	};
}

describe("ChatGPT account/session lifecycle", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("cannot refresh a retained registration after logout wins the store lock", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({
			type: "oauth",
			access: "",
			refresh: "",
			expires: 0,
			signedOut: true,
		}));
		const refresh = vi.fn();
		expect(
			await refreshStoredOAuthCredential(
				credentials,
				"openai",
				{ ...openaiChatGPTOAuth, refresh },
				() => true,
				new AbortController().signal,
			),
		).toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("keeps distinct account token sets when selecting another account", async () => {
		const combined = withOpenAIAccounts(credential("account-b", "oaiapp_b"), credential());
		expect(openAIAccounts(combined).map((entry) => entry.subject)).toEqual(["account-a", "account-b"]);
		const selected = await chooseOpenAIAccount(
			{ signal: new AbortController().signal, notify: () => {}, prompt: async () => "0" },
			combined,
		);
		expect(selected).toMatchObject({ clientId: "oaiapp_a", subject: "account-a", idToken: "identity-account-a" });
	});

	it("revokes every saved session and retains only signed-out registrations", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () =>
			withOpenAIAccounts(credential("account-b", "oaiapp_b"), credential()),
		);
		const revoked: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url, init) => {
				expect(String(url)).toBe("https://auth.openai.com/api/accounts/oauth/revoke");
				const body = new URLSearchParams(init.body);
				revoked.push(body.get("token")!);
				expect(body.get("token_type_hint")).toBe("refresh_token");
				return new Response(null, { status: 200 });
			}),
		);
		const models = createModels({
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(openaiProvider());
		await models.logout("openai");
		expect(revoked).toEqual(["refresh-account-a", "refresh-account-b"]);
		const saved = await credentials.read("openai");
		expect(saved).toMatchObject({ signedOut: true, access: "", refresh: "", expires: 0 });
		expect(JSON.stringify(saved)).not.toMatch(/identity-account|refresh-account|access-account/);
		expect(await models.checkAuth("openai")).toBeUndefined();
		expect(await models.getAuth("openai")).toBeUndefined();
		expect(await models.getAvailable("openai")).toEqual([]);
		expect(await credentials.list()).toEqual([]);
		expect(openAIAccounts(saved)).toEqual([
			{ clientId: "oaiapp_a", subject: "account-a" },
			{ clientId: "oaiapp_b", subject: "account-b" },
		]);
	});

	it("clears local secrets and reports unconfirmed revocation", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => credential());
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 400 })),
		);
		const models = createModels({
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(openaiProvider());
		await expect(models.logout("openai")).rejects.toThrow("Signed out locally");
		expect(await models.getAuth("openai")).toBeUndefined();
		expect(await credentials.read("openai")).toMatchObject({ signedOut: true, access: "", refresh: "" });
	});

	it("updates the account's stored token pair on rotation", async () => {
		const previous = withOpenAIAccounts(credential());
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					access_token: "new-access",
					refresh_token: "new-refresh",
					expires_in: 3600,
					scope: "chatgpt.tokens.use.direct",
				}),
			),
		);
		const refreshed = await openaiChatGPTOAuth.refresh(previous, new AbortController().signal);
		expect(openAIAccounts(refreshed)[0]).toMatchObject({
			access: "new-access",
			refresh: "new-refresh",
			subject: "account-a",
		});
	});

	it("does not mix model availability between ChatGPT accounts", async () => {
		const credentials = new InMemoryCredentialStore();
		const provider = openaiProvider();
		const first = provider.getModels()[0];
		const second = provider.getModels()[1];
		const models = createModels({ credentials });
		models.setProvider(provider);
		await credentials.modify("openai", async () => ({
			...credential(),
			availableModels: [{ id: first.id, name: "Account A choice" }],
		}));
		expect((await models.getAvailable("openai")).map((model) => model.id)).toEqual([first.id]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ models: [{ slug: second.id, display_name: "Live A choice", visibility: "list" }] }),
			),
		);
		await models.refresh({ providers: ["openai"] });
		expect((await models.getAvailable("openai")).map((model) => model.name)).toEqual(["Live A choice"]);
		await credentials.modify("openai", async () => ({
			...credential("account-b", "oaiapp_b"),
			availableModels: [{ id: first.id }],
		}));
		expect((await models.getAvailable("openai")).map((model) => model.id)).toEqual([first.id]);
	});
});
