import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type AuthPrompt } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { KeychainBackend } from "../src/core/auth-storage/keychain.ts";
import { confirmPlaintextHost, KeychainLoginSession } from "../src/core/auth-storage/keychain-login.ts";
import { resolveKeychainEndpoint } from "../src/core/auth-storage/keychain-endpoint.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const KEY = "bearer-test-value-1234";

/** A keychain whose reference is a real `!cat` of a temp file, so a stored record resolves like a real one. */
let keychainDir: string;
function fakeKeychain(): KeychainBackend & { stored: Map<string, string>; removed: string[] } {
	const stored = new Map<string, string>();
	const removed: string[] = [];
	const file = (account: string) => join(keychainDir, account);
	return {
		name: "fake keychain",
		stored,
		removed,
		store: async (account, secret) => {
			stored.set(account, secret);
			writeFileSync(file(account), secret);
		},
		remove: async (account) => {
			removed.push(account);
			stored.delete(account);
		},
		referenceFor: (account) => `!cat '${file(account)}'`,
		isOwnReference: (key, account) => key === `!cat '${file(account)}'`,
	};
}

beforeEach(() => {
	keychainDir = mkdtempSync(join(tmpdir(), "octocode-fake-keychain-"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(keychainDir, { recursive: true, force: true });
});

/** The Bedrock login's own prompts, answered in order; `unknown` host also gets the API question. */
function answers(...values: string[]) {
	const asked: AuthPrompt[] = [];
	const queue = [...values];
	return { asked, prompt: async (request: AuthPrompt) => (asked.push(request), queue.shift() ?? "") };
}

/** auth.json on disk, so a test can read exactly what is stored there. */
function fileStorage(keychain: KeychainBackend): AuthStorage {
	return AuthStorage.create(join(keychainDir, "auth.json"), { keychain });
}

async function runtimeFor(storage: AuthStorage) {
	return ModelRuntime.create({
		credentials: storage,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

async function loginBedrock(storage: AuthStorage, session: KeychainLoginSession, ...values: string[]) {
	const runtime = await runtimeFor(storage);
	const { prompt, asked } = answers(...values);
	const credential = await runtime.login(
		"amazon-bedrock",
		"api_key",
		{ prompt: session.wrapPrompt(prompt), notify: () => {} },
		{},
		{ transformCredential: session.transformCredential },
	);
	return { credential, asked };
}

describe("Amazon Bedrock dialog: custom host and region saved with the key", () => {
	test("keychain: key, host and region are one record; auth.json keeps only a reference", async () => {
		const keychain = fakeKeychain();
		const storage = fileStorage(keychain);
		const session = new KeychainLoginSession(keychain, "amazon-bedrock", async () => "keychain");
		const host = "https://bedrock-mantle.eu-central-1.api.aws/v1";
		const { asked } = await loginBedrock(storage, session, "bearer-token", KEY, host, "eu-central-1");
		expect(asked.map((request) => request.type)).toEqual(["select", "secret", "text", "text"]);
		expect(asked[2]?.message).toMatch(/Custom OpenAI-compatible host/);
		const record = JSON.parse(keychain.stored.get("amazon-bedrock.endpoint") ?? "{}");
		expect(record).toMatchObject({ key: KEY, endpoint: { baseUrl: host, region: "eu-central-1" } });
		const raw = readFileSync(join(keychainDir, "auth.json"), "utf8");
		expect(raw).not.toContain(KEY);
		expect(raw).not.toContain("api.aws");
		expect(JSON.parse(raw)["amazon-bedrock"]).toEqual({ type: "api_key", keychain: expect.stringContaining("!cat") });
		expect(storage.storedIn("amazon-bedrock")).toBe("keychain");
	});

	test("an unknown host asks which API it serves, and validates https", async () => {
		const keychain = fakeKeychain();
		const session = new KeychainLoginSession(keychain, "amazon-bedrock", async () => "keychain");
		const { asked } = await loginBedrock(
			fileStorage(keychain),
			session,
			"bearer-token",
			KEY,
			"llm.corp.example/v1",
			"",
			"openai-completions",
		);
		expect(asked.at(-1)?.type).toBe("select");
		const record = JSON.parse(keychain.stored.get("amazon-bedrock.endpoint") ?? "{}");
		expect(record.endpoint).toEqual({ baseUrl: "https://llm.corp.example/v1", api: "openai-completions" });
		const plain = new KeychainLoginSession(keychain, "amazon-bedrock", async () => "keychain");
		await expect(
			loginBedrock(fileStorage(keychain), plain, "bearer-token", KEY, "http://llm.corp.example/v1"),
		).rejects.toThrow(/https/);
	});

	test("a bedrock-mantle host needs a bearer token, not AWS credentials", async () => {
		const keychain = fakeKeychain();
		const session = new KeychainLoginSession(keychain, "amazon-bedrock", async () => "keychain");
		await expect(
			loginBedrock(fileStorage(keychain), session, "aws-profile", "dev", "https://bedrock-mantle.us-east-1.api.aws/v1"),
		).rejects.toThrow(/bearer token/);
		expect(keychain.stored.size).toBe(0);
	});

	test("file choice keeps the endpoint in auth.json only after the explicit choice", async () => {
		const keychain = fakeKeychain();
		const storage = fileStorage(keychain);
		const session = new KeychainLoginSession(keychain, "amazon-bedrock", async () => "file");
		await loginBedrock(storage, session, "bearer-token", KEY, "https://bedrock-runtime.eu-central-1.amazonaws.com", "");
		expect(keychain.stored.size).toBe(0);
		const stored = await storage.modify("amazon-bedrock", async (current) => current);
		expect(stored).toMatchObject({
			type: "api_key",
			key: KEY,
			endpoint: { baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com" },
		});
	});

	test("with no keychain, a host answer asks for confirmation and a refusal cancels before saving", async () => {
		const confirm = vi.fn(async () => false);
		const prompt = confirmPlaintextHost(async () => "https://llm.corp.example", confirm);
		await expect(prompt({ type: "text", message: "host", storedWithKey: true })).rejects.toThrow(/cancelled/);
		expect(confirm).toHaveBeenCalledTimes(1);
		const fine = confirmPlaintextHost(async () => "", confirm);
		await fine({ type: "text", message: "host", storedWithKey: true });
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	test("logout removes the record: key, host and region together", async () => {
		const keychain = fakeKeychain();
		const storage = fileStorage(keychain);
		const session = new KeychainLoginSession(keychain, "amazon-bedrock", async () => "keychain");
		await loginBedrock(
			storage,
			session,
			"bearer-token",
			KEY,
			"https://bedrock-mantle.eu-central-1.api.aws/v1",
			"eu-central-1",
		);
		await storage.delete("amazon-bedrock");
		expect(readFileSync(join(keychainDir, "auth.json"), "utf8")).not.toContain("amazon-bedrock");
		expect(keychain.removed).toContain("amazon-bedrock.endpoint");
		expect(keychain.stored.size).toBe(0);
	});

	test("reading a stub returns the full credential from the record; an unreadable record never yields a key", () => {
		const record = JSON.stringify({
			key: KEY,
			endpoint: { baseUrl: "https://llm.corp.example/v1", region: "eu-central-1" },
		});
		const stub = { type: "api_key" as const, keychain: `!printf '%s' '${record}'` };
		expect(resolveKeychainEndpoint(stub, true)).toMatchObject({ key: KEY, endpoint: { region: "eu-central-1" } });
		const broken = resolveKeychainEndpoint({ type: "api_key", keychain: "!exit 1" }, true);
		expect(broken).toEqual({ type: "api_key", keychain: "!exit 1" });
	});
});
