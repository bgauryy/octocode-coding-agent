import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeychainBackend } from "../../src/core/auth-storage/keychain.ts";
import { templateKeyAccount } from "../../src/core/provider-templates/key-store.ts";
import { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";
import { writeConfigProvider } from "../../src/octocode/web-daemon/provider-write.ts";

const SECRET = "SENTINEL-TEMPLATE-KEY-3b9";
let root: string;
let agentDir: string;
let keychainDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-template-"));
	agentDir = path.join(root, "agent");
	keychainDir = path.join(root, "keychain");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(keychainDir);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function fakeKeychain(): KeychainBackend {
	const file = (account: string) => path.join(keychainDir, account);
	return {
		name: "fake keychain",
		store: async (account, secret) => fs.writeFileSync(file(account), secret),
		remove: async (account) => fs.rmSync(file(account), { force: true }),
		referenceFor: (account) => `!cat ${file(account)}`,
		isOwnReference: (key, account) => key === `!cat ${file(account)}`,
	};
}
const entryOf = (account: string) => {
	try {
		return fs.readFileSync(path.join(keychainDir, account), "utf8");
	} catch {
		return undefined;
	}
};
const modelsFile = () => path.join(agentDir, "models.json");
const readModels = (): Record<string, any> => JSON.parse(fs.readFileSync(modelsFile(), "utf8"));
const options = (keychain: KeychainBackend | null = fakeKeychain()) => ({
	agentDir,
	env: {},
	actor: "web:test",
	keychain,
});
const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error as ConfigWriteError,
	);
const create = (extra: object = {}) =>
	({
		action: "create-from-template",
		template: "custom-openai",
		provider: "my-host",
		host: "https://llm.example.com/v1",
		models: [{ id: "m1", contextWindow: 32000, maxOutput: 4096 }, { id: "m2" }],
		key: { kind: "keychain", key: SECRET },
		...extra,
	}) as never;

describe("provider.create-from-template", () => {
	it("writes a 0600 models.json entry that references the keychain key, never holds it", async () => {
		const audit = vi.fn();
		await writeConfigProvider(create(), { ...options(), audit });
		expect(entryOf(templateKeyAccount("my-host"))).toBe(SECRET);
		const entry = readModels().providers["my-host"];
		expect(entry).toMatchObject({
			baseUrl: "https://llm.example.com/v1",
			apiKey: `!cat ${path.join(keychainDir, "my-host.models")}`,
			models: [{ id: "m1", contextWindow: 32000, maxTokens: 4096 }, { id: "m2" }],
		});
		expect(fs.readFileSync(modelsFile(), "utf8")).not.toContain(SECRET);
		expect(fs.statSync(modelsFile()).mode & 0o777).toBe(0o600);
		expect(audit.mock.calls[0]?.[0]).toMatchObject({ action: "provider.create-from-template", outcome: "ok" });
		expect(JSON.stringify(audit.mock.calls)).not.toContain(SECRET);
	});

	it("refuses an official id and a non-https host before storing any key", async () => {
		const official = await refusal(writeConfigProvider(create({ provider: "anthropic" }), options()));
		expect(official?.status).toBe(409);
		const remote = await refusal(writeConfigProvider(create({ host: "http://remote.example.com" }), options()));
		expect(remote?.status).toBe(400);
		expect(fs.readdirSync(keychainDir)).toEqual([]);
		expect(fs.existsSync(modelsFile())).toBe(false);
	});

	it("refuses an id models.json already defines", async () => {
		await writeConfigProvider(create(), options());
		const again = await refusal(writeConfigProvider(create(), options()));
		expect(again?.status).toBe(409);
	});

	it("takes the keychain entry back when models.json cannot be written", async () => {
		fs.writeFileSync(modelsFile(), '// a comment\n{"providers":{}}');
		const error = await refusal(writeConfigProvider(create(), options()));
		expect(error).toBeInstanceOf(ConfigWriteError);
		expect(entryOf(templateKeyAccount("my-host"))).toBeUndefined();
		expect(error?.message).not.toContain(SECRET);
	});

	it("stores no key for an environment variable, and refuses the keychain when there is none", async () => {
		await writeConfigProvider(create({ key: { kind: "env", name: "MY_HOST_KEY" } }), options(null));
		expect(readModels().providers["my-host"].apiKey).toBe("$MY_HOST_KEY");
		const none = await refusal(writeConfigProvider(create({ provider: "other" }), options(null)));
		expect(none?.status).toBe(409);
	});

	it("keeps plain text to auth.json and only with the acknowledgement", async () => {
		await writeConfigProvider(
			create({ key: { kind: "plaintext", key: SECRET, acknowledgePlaintext: true } }),
			options(null),
		);
		expect(fs.readFileSync(modelsFile(), "utf8")).not.toContain(SECRET);
		expect(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")).toContain(SECRET);
	});
});
