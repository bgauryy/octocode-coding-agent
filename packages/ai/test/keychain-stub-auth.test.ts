import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { AuthContext } from "../src/auth/types.ts";
import { checkProviderAuth } from "../src/models/auth.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { azureProvider } from "../src/providers/azure.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";

/** Ambient credentials of every kind, so a fallback to them would make the provider look ready. */
const ambient: AuthContext = {
	env: async (name) =>
		name.startsWith("AWS_") || name.startsWith("AZURE_") || name.startsWith("GOOGLE_") ? "set" : undefined,
	fileExists: async () => true,
};
const stub = { type: "api_key" as const, keychain: "!security find-generic-password -a x -w" };
const signal = new AbortController().signal;

describe("a keychain-only stub whose record cannot be read", () => {
	const providers = [
		["amazon-bedrock", amazonBedrockProvider()],
		["google-vertex", googleVertexProvider()],
		["azure", azureProvider()],
	] as const;

	test.each(providers)("%s never resolves as a stored credential", async (id, provider) => {
		const store = new InMemoryCredentialStore();
		await store.modify(id, async () => stub);
		await expect(resolveProviderAuth(provider as never, store, ambient, { signal })).rejects.toThrow(/keychain/);
	});

	test.each(providers)("%s is not configured instead of ready on ambient credentials", async (id, provider) => {
		const store = new InMemoryCredentialStore();
		await store.modify(id, async () => stub);
		await expect(checkProviderAuth(store, ambient, provider as never, stub, signal)).resolves.toBeUndefined();
	});
});
