import { describe, expect, it } from "vitest";
import type { AuthStatus } from "../src/core/provider-composer/types.ts";
import { buildProviderSnapshot } from "../src/core/provider-view/snapshot.ts";

async function entryFor(status: AuthStatus, saved: boolean) {
	const runtime = {
		getProviders: () => [{ id: "p", name: "P" }],
		getProvider: () => ({ id: "p", name: "P" }),
		getProviderKind: () => "account",
		getProviderAuthStatus: () => status,
		hasConfiguredAuth: () => status.configured,
		getAvailableSnapshot: () => [],
		getPlanDisabledReason: () => undefined,
		getProviderDefinitionFile: () => undefined,
		listCredentials: async () => (saved ? [{ providerId: "p", type: "api_key" }] : []),
		readCredential: async () => undefined,
		getAuth: async () => undefined,
	};
	const snapshot = await buildProviderSnapshot({ runtime: runtime as never, disabledProviders: [] });
	return snapshot.entry("p");
}

describe("/providers cause for an unset environment variable", () => {
	it("says which variable is not set and offers to set it or add a key", async () => {
		const entry = await entryFor({ configured: false, source: "environment", label: "LAB_API_KEY" }, false);
		expect(entry).toMatchObject({
			state: "needs-key",
			statusText: "needs key · environment variable LAB_API_KEY is not set",
			nextStep: { action: "add-key", label: "set LAB_API_KEY, or add a key" },
		});
	});

	it("falls back to the saved-credential cause when a credential is stored", async () => {
		const entry = await entryFor({ configured: false, source: "environment", label: "LAB_API_KEY" }, true);
		expect(entry?.statusText).toContain("saved credential");
		expect(entry?.statusText).not.toContain("is not set");
	});
});
