import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { KeychainBackend } from "../src/core/auth-storage/keychain.ts";
import { credentialState } from "../src/core/provider-composer/credential-state.ts";
import { providerRows } from "../src/modes/interactive/interactive-mode/provider-rows.ts";

const NOW = 1_000_000;
const oauth = (extra: object) => ({ type: "oauth" as const, access: "a", refresh: "r", expires: NOW + 1, ...extra });

describe("credential state", () => {
	it("names connected, expired, signed out and not set", () => {
		const configured = { configured: true, source: "stored" } as const;
		expect(credentialState(configured, { type: "api_key", key: "k" }, NOW)).toBe("connected");
		expect(credentialState(configured, oauth({}), NOW)).toBe("connected");
		expect(credentialState(configured, oauth({ expires: NOW - 1 }), NOW)).toBe("connected"); // refresh can renew it
		expect(credentialState(configured, oauth({ expires: NOW - 1, refresh: "" }), NOW)).toBe("expired");
		expect(
			credentialState(configured, oauth({ expires: NOW - 1, refreshRejected: { at: 1, refreshSha256: "x" } }), NOW),
		).toBe("expired");
		expect(
			credentialState(
				{ configured: false, source: "stored" },
				oauth({ signedOut: true, access: "", refresh: "" }),
				NOW,
			),
		).toBe("signed out");
		expect(credentialState({ configured: false }, undefined, NOW)).toBe("not set");
		expect(credentialState({ configured: true, source: "runtime" }, undefined, NOW)).toBe("connected");
	});

	it("shows an expired sign-in on its row as needing attention", () => {
		const runtime = {
			getProviders: () => [{ id: "p", name: "P" }],
			getProvider: () => ({ id: "p", name: "P" }),
			getProviderKind: () => "account",
			getProviderAuthStatus: () => ({ configured: true, source: "stored", label: "auth.json" }),
			hasConfiguredAuth: () => true,
			getAvailableSnapshot: () => [{ provider: "p" }],
			getPlanDisabledReason: () => undefined,
		};
		const rows = providerRows(
			runtime as never,
			[],
			[{ providerId: "p", type: "oauth" }],
			new Set(),
			new Map([["p", "expired"]]),
		);
		expect(rows.attention[0]).toMatchObject({ badge: "expired" });
		expect(rows.attention[0].detail).toContain("expired · auth.json");
	});
});

describe("where auth.json keeps a secret", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("tells a keychain reference from a file entry", () => {
		dir = mkdtempSync(join(tmpdir(), "octocode-storedin-"));
		const keychain: KeychainBackend = {
			name: "fake",
			store: async () => {},
			remove: async () => {},
			referenceFor: (account) => `!fake ${account}`,
			isOwnReference: (key, account) => key === `!fake ${account}`,
		};
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				a: { type: "api_key", key: "!fake a" },
				b: { type: "api_key", key: "plain" },
				c: { type: "oauth", access: "", refresh: "", expires: 1, keychain: "!fake c.oauth" },
			}),
		);
		const storage = AuthStorage.create(authPath, { keychain });
		expect(storage.storedIn("a")).toBe("keychain");
		expect(storage.storedIn("b")).toBe("auth.json");
		expect(storage.storedIn("c")).toBe("keychain");
		expect(storage.storedIn("none")).toBeUndefined();
	});
});
