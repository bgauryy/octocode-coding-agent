import type { Credential } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveKeychainOAuth } from "../src/core/auth-storage/keychain-oauth.ts";
import { clearConfigValueCache, resolveConfigValue } from "../src/core/config-value.ts";

afterEach(() => clearConfigValueCache());

/** Reads `provider` and reports whether a 20 ms timer fired before the read finished. */
async function readWhileTicking(storage: AuthStorage, provider: string) {
	let ticked = false;
	const timer = setTimeout(() => (ticked = true), 20);
	const credential = await storage.read(provider);
	clearTimeout(timer);
	return { credential, ticked };
}

// Fake keychain commands only: no real keychain is read and no secret is printed.
const blob = JSON.stringify({ access: "fake-access", refresh: "fake-refresh", expires: 1, accountId: "fake" });
const stub = (keychain: string): Credential => ({ type: "oauth", access: "", refresh: "", expires: 1, keychain });

describe("AuthStorage.read with keychain commands", () => {
	test("an API key behind a command resolves to the same key without blocking the thread", async () => {
		const key = "!sleep 0.3; printf fake-command-key";
		const storage = AuthStorage.inMemory({ fake: { type: "api_key", key } });
		const { credential, ticked } = await readWhileTicking(storage, "fake");
		expect(ticked).toBe(true);
		clearConfigValueCache();
		expect(credential).toEqual({ type: "api_key", key: resolveConfigValue(key) });
		expect(credential).toEqual({ type: "api_key", key: "fake-command-key" });
	});

	test("an OAuth stub resolves to the same credential without blocking the thread", async () => {
		const reference = `!sleep 0.3; printf '%s' '${blob}'`;
		const storage = AuthStorage.inMemory({ fake: stub(reference) });
		const { credential, ticked } = await readWhileTicking(storage, "fake");
		expect(ticked).toBe(true);
		clearConfigValueCache();
		expect(credential).toEqual(resolveKeychainOAuth(stub(reference)));
		expect(credential).toMatchObject({
			type: "oauth",
			access: "fake-access",
			refresh: "fake-refresh",
			accountId: "fake",
		});
	});

	test("a keychain that cannot be read leaves the stub, as before", async () => {
		const storage = AuthStorage.inMemory({ fake: stub("!exit 1") });
		expect(await storage.read("fake")).toEqual(stub("!exit 1"));
	});
});
