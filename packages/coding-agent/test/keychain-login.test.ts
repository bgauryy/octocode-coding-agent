import { InMemoryModelsStore, type AuthPrompt, type Credential } from "@octocodeai/octocode-ai";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { KeychainBackend } from "../src/core/auth-storage/keychain.ts";
import { type KeychainChoice, KeychainLoginSession } from "../src/core/auth-storage/keychain-login.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";
import { clearConfigValueCache, resolveConfigValue } from "@octocodeai/octocode-ai/utils/resolve-config-value";

function fakeKeychain(options: { failStore?: boolean } = {}): KeychainBackend & {
	stored: Map<string, string>;
	removed: string[];
} {
	const stored = new Map<string, string>();
	const removed: string[] = [];
	return {
		name: "fake keychain",
		stored,
		removed,
		store: async (provider, secret) => {
			if (options.failStore) throw new Error("keychain locked");
			stored.set(provider, secret);
		},
		remove: async (provider) => {
			removed.push(provider);
			stored.delete(provider);
		},
		referenceFor: (provider) => `!fake lookup ${provider}`,
		isOwnReference: (key, provider) => key === `!fake lookup ${provider}`,
	};
}

const secretPrompt: AuthPrompt = { type: "secret", message: "Enter API key" };

async function createRuntime(storage: AuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: storage,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

async function login(
	storage: AuthStorage,
	session: KeychainLoginSession,
	secret: string,
	provider = "opencode",
): Promise<Credential> {
	const runtime = await createRuntime(storage);
	const prompt = session.wrapPrompt(async () => secret);
	return runtime.login(
		provider,
		"api_key",
		{ prompt, notify: () => {} },
		{},
		{ transformCredential: session.transformCredential },
	);
}

describe("KeychainLoginSession", () => {
	test("asks once after the secret is entered and ignores other prompts", async () => {
		const ask = vi.fn(async (): Promise<KeychainChoice> => "file");
		const session = new KeychainLoginSession(fakeKeychain(), "opencode", ask);
		const inner = vi.fn(async () => "typed");
		const prompt = session.wrapPrompt(inner);
		expect(await prompt({ type: "text", message: "Account ID" })).toBe("typed");
		expect(ask).not.toHaveBeenCalled();
		expect(await prompt(secretPrompt)).toBe("typed");
		expect(await prompt(secretPrompt)).toBe("typed");
		expect(ask).toHaveBeenCalledTimes(1);
	});

	test("does not ask for an empty optional secret", async () => {
		const ask = vi.fn(async (): Promise<KeychainChoice> => "keychain");
		const session = new KeychainLoginSession(fakeKeychain(), "llama.cpp", ask);
		await session.wrapPrompt(async () => "  ")(secretPrompt);
		expect(ask).not.toHaveBeenCalled();
	});

	test("keychain choice stores the secret and saves only the reference", async () => {
		const keychain = fakeKeychain();
		const storage = AuthStorage.inMemory({}, { keychain });
		const session = new KeychainLoginSession(keychain, "opencode", async () => "keychain");
		const credential = await login(storage, session, "sk-secret");
		expect(credential).toMatchObject({ type: "api_key" });
		expect(keychain.stored.get("opencode")).toBe("sk-secret");
		const stored = await storage.modify("opencode", async (current) => current);
		expect(stored).toEqual({ type: "api_key", key: "!fake lookup opencode" });
	});

	test("file choice saves the key as typed and never touches the keychain", async () => {
		const keychain = fakeKeychain();
		const storage = AuthStorage.inMemory({}, { keychain });
		const session = new KeychainLoginSession(keychain, "opencode-go", async () => "file");
		await login(storage, session, "sk-plain", "opencode-go");
		expect(keychain.stored.size).toBe(0);
		expect(await storage.modify("opencode-go", async (current) => current)).toEqual({
			type: "api_key",
			key: "sk-plain",
		});
	});

	test("a keychain failure preserves the previous credential without writing plaintext", async () => {
		const keychain = fakeKeychain({ failStore: true });
		const storage = AuthStorage.inMemory({ opencode: { type: "api_key", key: "old-key" } }, { keychain });
		const session = new KeychainLoginSession(keychain, "opencode", async () => "keychain");
		await expect(login(storage, session, "sk-secret")).rejects.toMatchObject({
			message:
				"Credential store modify failed for opencode: Could not save to the system keychain. No plaintext fallback was written.",
			cause: { message: "Could not save to the system keychain. No plaintext fallback was written." },
		});
		expect(await storage.modify("opencode", async (current) => current)).toEqual({
			type: "api_key",
			key: "old-key",
		});
	});

	test.each(["login", "import"] as const)(
		"%s completes the credential commit when cancelled during a keychain write",
		async (mode) => {
			const keychain = fakeKeychain();
			keychain.stored.set("opencode", "old-key");
			const storage = AuthStorage.inMemory(
				{ opencode: { type: "api_key", key: "!fake lookup opencode" } },
				{ keychain },
			);
			const runtime = await createRuntime(storage);
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			keychain.store = async (provider, secret) => {
				started.resolve();
				await release.promise;
				keychain.stored.set(provider, secret);
			};
			const session = new KeychainLoginSession(keychain, "opencode", async () => "keychain");
			const prompt = session.wrapPrompt(async () => "new-key");
			const controller = new AbortController();
			if (mode === "import") await prompt(secretPrompt);
			const operation =
				mode === "login"
					? runtime.login(
							"opencode",
							"api_key",
							{ prompt, notify: () => {}, signal: controller.signal },
							{},
							{ transformCredential: session.transformCredential },
						)
					: runtime.importCredential(
							"opencode",
							{ type: "api_key", key: "new-key" },
							{ signal: controller.signal },
							{ transformCredential: session.transformCredential },
						);
			await started.promise;
			controller.abort();
			release.resolve();
			await expect(operation).rejects.toBeInstanceOf(CredentialSynchronizationError);
			expect(keychain.stored.get("opencode")).toBe("new-key");
			expect(await storage.modify("opencode", async (current) => current)).toEqual({
				type: "api_key",
				key: "!fake lookup opencode",
			});
		},
	);

	test.each(["login", "import"] as const)("%s preserves the old key when cancelled before the commit", async (mode) => {
		const keychain = fakeKeychain();
		keychain.stored.set("opencode", "old-key");
		const storage = AuthStorage.inMemory({ opencode: { type: "api_key", key: "!fake lookup opencode" } }, { keychain });
		const runtime = await createRuntime(storage);
		const session = new KeychainLoginSession(keychain, "opencode", async () => "keychain");
		const prompt = session.wrapPrompt(async () => "new-key");
		const signal = AbortSignal.abort();
		const operation =
			mode === "login"
				? runtime.login(
						"opencode",
						"api_key",
						{ prompt, notify: () => {}, signal },
						{},
						{ transformCredential: session.transformCredential },
					)
				: runtime.importCredential(
						"opencode",
						{ type: "api_key", key: "new-key" },
						{ signal },
						{ transformCredential: session.transformCredential },
					);
		await expect(operation).rejects.toMatchObject({ name: "AbortError" });
		expect(keychain.stored.get("opencode")).toBe("old-key");
		expect(await storage.modify("opencode", async (current) => current)).toEqual({
			type: "api_key",
			key: "!fake lookup opencode",
		});
	});

	test("leaves a credential whose key was not the typed secret alone", async () => {
		const keychain = fakeKeychain();
		const session = new KeychainLoginSession(keychain, "opencode", async () => "keychain");
		await session.wrapPrompt(async () => "sk-secret")(secretPrompt);
		const other: Credential = { type: "api_key", key: "different" };
		expect(await session.transformCredential(other)).toBe(other);
		const oauth: Credential = { type: "oauth", access: "a", refresh: "r", expires: 0 };
		expect(await session.transformCredential(oauth)).toBe(oauth);
		expect(keychain.stored.size).toBe(0);
	});

	test("clears the command cache so a re-login does not read the previous secret", async () => {
		const keychain = { ...fakeKeychain(), referenceFor: () => '!printf %s "$KEYCHAIN_LOGIN_TEST"' };
		process.env.KEYCHAIN_LOGIN_TEST = "old";
		try {
			clearConfigValueCache();
			expect(resolveConfigValue(keychain.referenceFor())).toBe("old");
			const session = new KeychainLoginSession(keychain, "opencode", async () => "keychain");
			await session.wrapPrompt(async () => "new")(secretPrompt);
			process.env.KEYCHAIN_LOGIN_TEST = "new";
			await session.transformCredential({ type: "api_key", key: "new" });
			expect(resolveConfigValue(keychain.referenceFor())).toBe("new");
		} finally {
			delete process.env.KEYCHAIN_LOGIN_TEST;
			clearConfigValueCache();
		}
	});

	test("does not reuse a completed login's credential transform for the next login", async () => {
		const storage = AuthStorage.inMemory();
		const runtime = await createRuntime(storage);
		const interaction = { prompt: async () => "typed-key", notify: () => {} };
		const transformCredential = vi.fn(async (credential: Credential) => ({ ...credential, key: "stored-key" }));
		await runtime.login("opencode", "api_key", interaction, {}, { transformCredential });
		expect(await storage.modify("opencode", async (current) => current)).toEqual({
			type: "api_key",
			key: "stored-key",
		});
		await runtime.login("opencode", "api_key", interaction);
		expect(await storage.modify("opencode", async (current) => current)).toEqual({ type: "api_key", key: "typed-key" });
		expect(transformCredential).toHaveBeenCalledTimes(1);
	});

	test("removes a failed credential transform before retrying login", async () => {
		const storage = AuthStorage.inMemory();
		const runtime = await createRuntime(storage);
		const interaction = { prompt: async () => "typed-key", notify: () => {} };
		const transformCredential = vi.fn(async () => {
			throw new Error("storage unavailable");
		});
		await expect(runtime.login("opencode", "api_key", interaction, {}, { transformCredential })).rejects.toThrow(
			"Credential store modify failed",
		);
		expect(await storage.list()).toEqual([]);
		await runtime.login("opencode", "api_key", interaction);
		expect(await storage.modify("opencode", async (current) => current)).toEqual({ type: "api_key", key: "typed-key" });
		expect(transformCredential).toHaveBeenCalledTimes(1);
	});
});

describe("AuthStorage logout cleanup", () => {
	test("removes the keychain entry when the stored key is our own reference", async () => {
		const keychain = fakeKeychain();
		keychain.stored.set("opencode", "sk-secret");
		const storage = AuthStorage.inMemory({ opencode: { type: "api_key", key: "!fake lookup opencode" } }, { keychain });
		await storage.delete("opencode");
		expect(keychain.removed).toEqual(["opencode"]);
		expect(await storage.list()).toEqual([]);
	});

	test("leaves entries alone for other keys, other providers and OAuth", async () => {
		const keychain = fakeKeychain();
		const storage = AuthStorage.inMemory(
			{
				plain: { type: "api_key", key: "sk-plain" },
				custom: { type: "api_key", key: "!security find-generic-password -ws 'custom'" },
				crossed: { type: "api_key", key: "!fake lookup opencode" },
				oauth: { type: "oauth", access: "a", refresh: "r", expires: 0 },
			},
			{ keychain },
		);
		for (const provider of ["plain", "custom", "crossed", "oauth", "absent"]) await storage.delete(provider);
		expect(keychain.removed).toEqual([]);
	});

	test("a failing keychain removal does not block logout", async () => {
		const keychain = fakeKeychain();
		keychain.remove = async () => {
			throw new Error("denied");
		};
		const storage = AuthStorage.inMemory({ opencode: { type: "api_key", key: "!fake lookup opencode" } }, { keychain });
		await expect(storage.delete("opencode")).resolves.toBeUndefined();
		expect(await storage.list()).toEqual([]);
	});
});
