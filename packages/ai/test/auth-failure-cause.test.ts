import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { ApiKeyAuth, AuthContext } from "../src/auth/types.ts";

const authContext: AuthContext = { env: async () => undefined, fileExists: async () => false };

function failingWith(error: Error): ApiKeyAuth {
	return {
		name: "Test key",
		resolve: async () => {
			throw error;
		},
	};
}

const resolveWith = (apiKey: ApiKeyAuth) =>
	resolveProviderAuth({ id: "gw", auth: { apiKey } }, new InMemoryCredentialStore(), authContext);

describe("API key resolution failure", () => {
	it("puts the cause's first line after the provider and the whole cause attached", async () => {
		const cause = new Error("environment variable LAB_KEY is not set\nsecond line with detail");
		const error = await resolveWith(failingWith(cause)).catch((caught: unknown) => caught);
		const failure = error as Error;
		expect(failure.name).toBe("ModelsError");
		expect(
			failure.message.startsWith("API key auth failed for provider gw: environment variable LAB_KEY is not set"),
		).toBe(true);
		expect(failure.cause).toBe(cause);
	});
});
