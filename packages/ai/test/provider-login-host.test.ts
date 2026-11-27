import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { Credential } from "../src/auth/types.ts";
import { azureProvider } from "../src/providers/azure.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import { googleProvider } from "../src/providers/google.ts";

/** Azure first asks which authentication to use; the others go straight to the key. */
const keyLogin = (id: string, ...answers: string[]) => interaction(...(id === "azure" ? ["api-key"] : []), ...answers);

const providers = [
	["google", googleProvider(), "https://gemini-proxy.corp.example/v1beta"],
	["github-copilot", githubCopilotProvider(), "https://copilot-api.corp.ghe.com"],
	["azure", azureProvider(), "https://my-resource.openai.azure.com/openai/v1"],
] as const;

type Login = NonNullable<NonNullable<ReturnType<typeof azureProvider>["auth"]["apiKey"]>["login"]>;
const login = (provider: { auth: { apiKey?: { login?: Login } } }, interaction: Parameters<Login>[0]) =>
	provider.auth.apiKey!.login!(interaction);

function interaction(...answers: string[]): Parameters<Login>[0] {
	const queue = [...answers];
	return { prompt: async () => queue.shift() ?? "", notify: () => {}, signal: new AbortController().signal };
}

describe("the optional login host", () => {
	it.each(providers)("%s asks for a host after the key and saves a valid one with it", async (id, provider, host) => {
		const credential = await login(provider, keyLogin(id, "the-key", host));
		expect(credential).toMatchObject({ type: "api_key", key: "the-key", endpoint: { baseUrl: host } });
	});

	it.each(providers)("%s keeps the official host when the answer is empty", async (id, provider) => {
		const credential = await login(provider, keyLogin(id, "the-key", ""));
		expect(credential).toEqual({ type: "api_key", key: "the-key" });
	});

	it.each(providers)("%s refuses a plain-http host that is not localhost", async (id, provider) => {
		await expect(login(provider, keyLogin(id, "the-key", "http://proxy.corp.example"))).rejects.toThrow();
	});

	it.each(providers)("%s accepts localhost over http", async (id, provider) => {
		const credential = await login(provider, keyLogin(id, "the-key", "http://localhost:8080"));
		expect(credential).toMatchObject({ endpoint: { baseUrl: "http://localhost:8080" } });
	});

	it.each(providers)("%s sends requests to the saved host", async (id, provider, host) => {
		const store = new InMemoryCredentialStore();
		const stored: Credential = { type: "api_key", key: "the-key", endpoint: { baseUrl: host } };
		await store.modify(id, async () => stored);
		const resolved = await resolveProviderAuth(
			provider,
			store,
			{ env: async () => undefined, fileExists: async () => false },
			{ signal: new AbortController().signal },
		);
		expect(resolved?.auth.baseUrl).toBe(host);
	});

	it("azure: an Entra token login can carry the resource URL too", async () => {
		const host = "https://my-resource.openai.azure.com/openai/v1";
		const credential = await login(azureProvider(), keyLogin("", "entra", " token \n", host));
		expect(credential).toEqual({
			type: "api_key",
			env: { AZURE_OPENAI_AD_TOKEN: "token" },
			endpoint: { baseUrl: host },
		});
	});
});
