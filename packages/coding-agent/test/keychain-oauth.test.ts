import type { Credential, OAuthCredential } from "@octocodeai/octocode-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { KeychainBackend } from "../src/core/auth-storage/keychain.ts";
import { KeychainWrite } from "../src/core/auth-storage/keychain-login.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";
import { clearConfigValueCache } from "../src/core/config-value.ts";

/**
 * A keychain double in an isolated temp home: each entry is a file, and its reference is a `!cat` command, so reading
 * a stub back runs the same `!command` resolution a real keychain reference does. No real keychain is touched.
 */
function fileKeychain(dir: string, options: { failStore?: boolean } = {}): KeychainBackend & { removed: string[] } {
	const removed: string[] = [];
	const file = (account: string) => join(dir, `${account}.secret`);
	return {
		name: "file keychain",
		removed,
		store: async (account, secret) => {
			if (options.failStore) throw new Error("keychain locked");
			writeFileSync(file(account), secret);
		},
		remove: async (account) => {
			removed.push(account);
			rmSync(file(account), { force: true });
		},
		referenceFor: (account) => `!cat '${file(account)}'`,
		isOwnReference: (key, account) => key === `!cat '${file(account)}'`,
	};
}

const signedIn = (suffix: string, expires: number): OAuthCredential => ({
	type: "oauth",
	access: `synthetic-access-${suffix}`,
	refresh: `synthetic-refresh-${suffix}`,
	expires,
	accountId: "acct-synthetic",
});

const saved = { ...process.env };
let home: string;
let authPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-keychain-oauth-"));
	process.env.HOME = home;
	authPath = join(home, "auth.json");
	clearConfigValueCache();
});

afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
	clearConfigValueCache();
	rmSync(home, { recursive: true, force: true });
});

const fileEntry = (provider: string): Credential => JSON.parse(readFileSync(authPath, "utf8"))[provider];

/** A login that saves through the keychain write, as the login dialogs and web settings do for API keys. */
async function loginToKeychain(storage: AuthStorage, keychain: KeychainBackend, credential: Credential) {
	const runtime = new RuntimeCredentials(storage);
	const write = new KeychainWrite(keychain, "openai-codex").asTransform();
	return runtime.withWriteTransform("openai-codex", write, () =>
		runtime.modify("openai-codex", async () => credential),
	);
}

describe.skipIf(process.platform === "win32")("OAuth credentials in the keychain", () => {
	test("a login stores one blob in the keychain and only a stub in auth.json; reads resolve it", async () => {
		const keychain = fileKeychain(home);
		const storage = AuthStorage.create(authPath, { keychain });
		await loginToKeychain(storage, keychain, signedIn("1", 1_000));

		const stub = fileEntry("openai-codex");
		expect(stub).toEqual({
			type: "oauth",
			access: "",
			refresh: "",
			expires: 1_000,
			keychain: keychain.referenceFor("openai-codex.oauth"),
		});
		expect(readFileSync(authPath, "utf8")).not.toContain("synthetic-");
		expect(JSON.parse(readFileSync(join(home, "openai-codex.oauth.secret"), "utf8"))).toEqual({
			access: "synthetic-access-1",
			refresh: "synthetic-refresh-1",
			expires: 1_000,
			accountId: "acct-synthetic",
		});
		expect(await storage.read("openai-codex")).toEqual(signedIn("1", 1_000));
	});

	test("a refresh sees the real tokens and writes the new ones back to the keychain", async () => {
		const keychain = fileKeychain(home);
		const storage = AuthStorage.create(authPath, { keychain });
		await loginToKeychain(storage, keychain, signedIn("1", 1_000));
		const stub = fileEntry("openai-codex");

		let seen: Credential | undefined;
		const post = await storage.modify("openai-codex", async (current) => {
			seen = current;
			return current?.type === "oauth" ? { ...current, ...signedIn("2", 2_000) } : undefined;
		});

		expect(seen).toEqual(signedIn("1", 1_000));
		expect(post).toEqual(signedIn("2", 2_000));
		expect(fileEntry("openai-codex")).toEqual({ ...stub, expires: 2_000 });
		expect(readFileSync(authPath, "utf8")).not.toContain("synthetic-");
		expect(await storage.read("openai-codex")).toEqual(signedIn("2", 2_000));
		// A second store over the same file reads the refreshed blob too.
		expect(await AuthStorage.create(authPath, { keychain }).read("openai-codex")).toEqual(signedIn("2", 2_000));
	});

	test("a refresh the keychain refuses keeps the tokens in auth.json instead of losing them", async () => {
		const keychain = fileKeychain(home);
		const storage = AuthStorage.create(authPath, { keychain });
		await loginToKeychain(storage, keychain, signedIn("1", 1_000));
		const locked = AuthStorage.create(authPath, { keychain: { ...fileKeychain(home, { failStore: true }) } });
		await locked.modify("openai-codex", async () => signedIn("2", 2_000));
		expect(fileEntry("openai-codex")).toEqual(signedIn("2", 2_000));
		expect(await locked.read("openai-codex")).toEqual(signedIn("2", 2_000));
	});

	test("a plaintext OAuth credential stays in auth.json on refresh", async () => {
		const keychain = fileKeychain(home);
		writeFileSync(authPath, JSON.stringify({ "openai-codex": signedIn("1", 1_000) }));
		const storage = AuthStorage.create(authPath, { keychain });
		await storage.modify("openai-codex", async () => signedIn("2", 2_000));
		expect(fileEntry("openai-codex")).toEqual(signedIn("2", 2_000));
		expect(existsSync(join(home, "openai-codex.oauth.secret"))).toBe(false);
	});

	test("signing out and removing the credential release the keychain entry", async () => {
		const keychain = fileKeychain(home);
		const storage = AuthStorage.create(authPath, { keychain });
		await loginToKeychain(storage, keychain, signedIn("1", 1_000));
		await storage.modify("openai-codex", async (current) =>
			current?.type === "oauth" ? { ...current, access: "", refresh: "", signedOut: true } : undefined,
		);
		expect(fileEntry("openai-codex")).toMatchObject({ type: "oauth", signedOut: true, access: "", refresh: "" });
		expect(keychain.removed).toEqual(["openai-codex.oauth"]);

		await loginToKeychain(storage, keychain, signedIn("3", 3_000));
		await storage.delete("openai-codex");
		expect(keychain.removed).toEqual(["openai-codex.oauth", "openai-codex.oauth"]);
		expect(existsSync(join(home, "openai-codex.oauth.secret"))).toBe(false);
	});

	test("a stub whose keychain entry is gone reads back as the stub, never as tokens", async () => {
		const keychain = fileKeychain(home);
		const storage = AuthStorage.create(authPath, { keychain });
		await loginToKeychain(storage, keychain, signedIn("1", 1_000));
		rmSync(join(home, "openai-codex.oauth.secret"));
		clearConfigValueCache();
		expect(await storage.read("openai-codex")).toMatchObject({ type: "oauth", access: "", refresh: "" });
	});
});
