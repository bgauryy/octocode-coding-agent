import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type AuthPrompt } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { KeychainBackend } from "../src/core/auth-storage/keychain.ts";
import { KeychainLoginSession } from "../src/core/auth-storage/keychain-login.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { isSecretName } from "../src/core/secret-redaction.ts";

const TOKEN = "entra-token-value-98765";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-env-secret-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A keychain whose reference is a real `!cat` of a temp file, so a stored record resolves like a real one. */
function fakeKeychain(): KeychainBackend & { stored: Map<string, string> } {
	const stored = new Map<string, string>();
	const file = (account: string) => join(dir, account);
	return {
		name: "fake keychain",
		stored,
		store: async (account, secret) => {
			stored.set(account, secret);
			writeFileSync(file(account), secret);
		},
		remove: async (account) => void stored.delete(account),
		referenceFor: (account) => `!cat '${file(account)}'`,
		isOwnReference: (key, account) => key === `!cat '${file(account)}'`,
	};
}

async function loginAzure(keychain: KeychainBackend, choice: "keychain" | "file", ...values: string[]) {
	const storage = AuthStorage.create(join(dir, "auth.json"), { keychain });
	const runtime = await ModelRuntime.create({
		credentials: storage,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const session = new KeychainLoginSession(keychain, "azure", async () => choice);
	const queue = [...values];
	const prompt = async (_request: AuthPrompt) => queue.shift() ?? "";
	await runtime.login(
		"azure",
		"api_key",
		{ prompt: session.wrapPrompt(prompt), notify: () => {} },
		{},
		{ transformCredential: session.transformCredential },
	);
	return { storage, runtime };
}

describe("a secret environment value of a credential (the Azure Entra token)", () => {
	test("keychain: the token is trimmed, kept in the keychain, and auth.json holds only a reference", async () => {
		const keychain = fakeKeychain();
		const { storage, runtime } = await loginAzure(keychain, "keychain", "entra", `  ${TOKEN}\n`, "");
		expect(JSON.parse(keychain.stored.get("azure.endpoint") ?? "{}")).toMatchObject({
			env: { AZURE_OPENAI_AD_TOKEN: TOKEN },
		});
		const raw = readFileSync(join(dir, "auth.json"), "utf8");
		expect(raw).not.toContain(TOKEN);
		expect(JSON.parse(raw).azure).toEqual({ type: "api_key", keychain: expect.stringContaining("!cat") });
		expect(storage.storedIn("azure")).toBe("keychain");
		const resolved = await runtime.getAuth("azure");
		expect(resolved?.auth.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	test("file: the trimmed token stays in auth.json when the file is chosen", async () => {
		const { storage } = await loginAzure(fakeKeychain(), "file", "entra", `  ${TOKEN}\n`, "");
		const raw = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
		expect(raw.azure.env.AZURE_OPENAI_AD_TOKEN).toBe(TOKEN);
		expect(storage.storedIn("azure")).toBe("auth.json");
	});

	test("keychain: a resource URL typed with the token is kept in the same record", async () => {
		const keychain = fakeKeychain();
		const host = "https://my-resource.openai.azure.com/openai/v1";
		const { runtime } = await loginAzure(keychain, "keychain", "entra", TOKEN, host);
		expect(JSON.parse(keychain.stored.get("azure.endpoint") ?? "{}")).toMatchObject({
			env: { AZURE_OPENAI_AD_TOKEN: TOKEN },
			endpoint: { baseUrl: host },
		});
		expect(readFileSync(join(dir, "auth.json"), "utf8")).not.toContain("azure.com");
		const resolved = await runtime.getAuth("azure");
		expect(resolved?.auth.baseUrl).toBe(host);
		expect(resolved?.env?.AZURE_OPENAI_BASE_URL).toBe(host);
	});

	test("the redactor treats AZURE_OPENAI_AD_TOKEN as a secret name", () => {
		expect(isSecretName("AZURE_OPENAI_AD_TOKEN")).toBe(true);
		expect(isSecretName("AZURE_OPENAI_API_VERSION")).toBe(false);
		expect(isSecretName("AWS_REGION")).toBe(false);
	});
});
