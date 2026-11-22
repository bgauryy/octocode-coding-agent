import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSnapshotSchema, type ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeychainBackend } from "../../src/core/auth-storage/keychain.ts";
import { templateKeyAccount } from "../../src/core/provider-templates/key-store.ts";
import { buildConfigSnapshot } from "../../src/octocode/web-daemon/config-status.ts";
import { writeConfigCredential } from "../../src/octocode/web-daemon/credential-write.ts";
import { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";
import { writeConfigProvider } from "../../src/octocode/web-daemon/provider-write.ts";

const SECRET = "SENTINEL-HOST-KEY-7c1e";
let root: string;
let agentDir: string;
let keychainDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-host-"));
	agentDir = path.join(root, "agent");
	keychainDir = path.join(root, "keychain");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(keychainDir);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"])
		vi.stubEnv(name, "");
	// Provider key checks answer from here: no request leaves the machine.
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

/** A keychain that keeps entries in a temp folder; its reference is a real command, so a record can be read back. */
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
const readAuth = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
const modelsFile = () => path.join(agentDir, "models.json");
const readModels = (): Record<string, any> => JSON.parse(fs.readFileSync(modelsFile(), "utf8"));

const credentialOptions = (keychain: KeychainBackend | null) => ({
	agentDir,
	keychain,
	env: {},
	actor: "web:test",
});
const set = (provider: string, extra: object = {}) =>
	writeConfigCredential({ action: "set", provider, key: SECRET, ...extra } as never, credentialOptions(fakeKeychain()));
const snapshotOf = (keychain: KeychainBackend | null = fakeKeychain()): Promise<ConfigSnapshot> =>
	buildConfigSnapshot({ agentDir, piDirs: [], home: root, keychain, env: {} });
const row = (snapshot: ConfigSnapshot, id: string) => snapshot.providers.find((entry) => entry.provider === id);
const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error as ConfigWriteError,
	);

describe("sign-in with a custom host", () => {
	it("offers the host question where the provider takes a base URL", async () => {
		const snapshot = await snapshotOf();
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		expect(row(snapshot, "anthropic")?.auth?.keyAuth?.host).toEqual({ example: "https://llm.example.com" });
		expect(row(snapshot, "amazon-bedrock")?.auth?.keyAuth?.host).toMatchObject({
			region: true,
			apis: expect.arrayContaining([{ id: "openai-completions", label: expect.any(String) }]),
		});
		expect(row(snapshot, "groq")?.auth?.keyAuth?.host).toBeUndefined();
	});

	it("saves the host with the key as one keychain record and shows it as the effective base URL", async () => {
		await set("anthropic", { host: "gateway.example.com/" });
		const stub = readAuth().anthropic;
		expect(stub).toEqual({ type: "api_key", keychain: `!cat ${path.join(keychainDir, "anthropic.endpoint")}` });
		expect(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")).not.toContain(SECRET);
		const record = JSON.parse(entryOf("anthropic.endpoint") ?? "{}");
		expect(record).toEqual({ key: SECRET, endpoint: { baseUrl: "https://gateway.example.com" } });
		expect(entryOf("anthropic")).toBeUndefined();

		const snapshot = await snapshotOf();
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		expect(row(snapshot, "anthropic")?.sources.map((source) => source.kind)).toEqual(["keychain"]);
		expect(row(snapshot, "anthropic")?.baseUrl).toEqual({ url: "https://gateway.example.com", source: "saved" });
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});

	it("shows the provider's own host until one is saved; replacing only the key keeps the saved host, and Clear removes the record", async () => {
		expect(row(await snapshotOf(), "anthropic")?.baseUrl).toEqual({
			url: "https://api.anthropic.com",
			source: "default",
		});
		await set("anthropic", { host: "https://gateway.example.com/v1" });
		await set("anthropic");
		expect(JSON.parse(entryOf("anthropic.endpoint") ?? "{}").endpoint).toEqual({
			baseUrl: "https://gateway.example.com/v1",
		});
		expect(row(await snapshotOf(), "anthropic")?.baseUrl).toEqual({
			url: "https://gateway.example.com/v1",
			source: "saved",
		});
		await writeConfigCredential({ action: "clear", provider: "anthropic" }, credentialOptions(fakeKeychain()));
		expect(entryOf("anthropic.endpoint")).toBeUndefined();
		expect(row(await snapshotOf(), "anthropic")?.baseUrl?.source).toBe("default");
	});

	it("keeps the host in auth.json beside a key stored as plain text without a keychain", async () => {
		await writeConfigCredential(
			{ action: "set", provider: "openai", key: SECRET, host: "http://localhost:8080/v1", acknowledgePlaintext: true },
			credentialOptions(null),
		);
		expect(readAuth().openai).toEqual({
			type: "api_key",
			key: SECRET,
			endpoint: { baseUrl: "http://localhost:8080/v1" },
		});
		expect(row(await snapshotOf(null), "openai")?.baseUrl).toEqual({
			url: "http://localhost:8080/v1",
			source: "saved",
		});
	});

	it("refuses a host the terminal would refuse, naming neither the host nor the key", async () => {
		for (const host of [
			"http://gateway.example.com",
			"https://user:hunter2@gateway.example.com",
			"https://gateway.example.com/?token=abc",
			"ftp://gateway.example.com",
		]) {
			const error = await refusal(set("anthropic", { host }));
			expect(error, host).toBeInstanceOf(ConfigWriteError);
			expect(error?.status).toBe(400);
			expect(error?.message).not.toMatch(/hunter2|gateway|abc/);
		}
		expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
		expect(entryOf("anthropic.endpoint")).toBeUndefined();
	});

	it("refuses a host for a provider that takes none, and a region or API without a host", async () => {
		expect((await refusal(set("groq", { host: "https://gateway.example.com" })))?.status).toBe(400);
		expect((await refusal(set("anthropic", { region: "eu-central-1" })))?.status).toBe(400);
		expect((await refusal(set("anthropic", { host: "https://g.example.com", region: "eu-west-1" })))?.status).toBe(400);
		expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
	});

	it("routes Amazon Bedrock hosts as the terminal does", async () => {
		// A bedrock-mantle host speaks the OpenAI-compatible API and needs the bearer token: no API to name.
		await set("amazon-bedrock", {
			host: "bedrock-mantle.us-east-1.api.aws/",
			region: "us-east-1",
		});
		expect(JSON.parse(entryOf("amazon-bedrock.endpoint") ?? "{}").endpoint).toEqual({
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws",
			region: "us-east-1",
		});
		// A host whose name does not tell must say which API it serves.
		const missing = await refusal(set("amazon-bedrock", { host: "https://proxy.example.com" }));
		expect(missing?.status).toBe(400);
		await set("amazon-bedrock", { host: "https://proxy.example.com", api: "openai-completions" });
		expect(JSON.parse(entryOf("amazon-bedrock.endpoint") ?? "{}").endpoint).toEqual({
			baseUrl: "https://proxy.example.com",
			api: "openai-completions",
		});
		expect((await refusal(set("amazon-bedrock", { host: "https://proxy.example.com", api: "nope" })))?.status).toBe(
			400,
		);
	});

	it("does not check a key against the official host when it is saved for another one", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			requests.push(String(input));
			return new Response("{}", { status: 401 });
		});
		await set("anthropic", { host: "https://gateway.example.com" });
		expect(requests).toEqual([]);
		// Replacing only the key keeps that host, so the key is still not the official host's.
		await set("anthropic");
		expect(requests).toEqual([]);
		// After Clear the official host applies again and the key is checked there.
		await writeConfigCredential({ action: "clear", provider: "anthropic" }, credentialOptions(fakeKeychain()));
		expect((await refusal(set("anthropic")))?.status).toBe(400);
	});
});

describe("custom providers on the provider page", () => {
	beforeEach(() => {
		fs.writeFileSync(
			modelsFile(),
			JSON.stringify({
				providers: {
					gateway: {
						name: "My gateway",
						baseUrl: "https://old.example.com/v1",
						api: "openai-completions",
						apiKey: "!fake lookup gateway.models",
						models: [{ id: "fast", contextWindow: 32000, maxTokens: 4096 }, { id: "plain" }],
					},
					other: { baseUrl: "https://other.example.com/v1", api: "openai-completions", models: [{ id: "m" }] },
				},
			}),
		);
	});
	const options = (keychain: KeychainBackend | null = fakeKeychain()) => ({
		agentDir,
		env: {},
		actor: "web:test",
		keychain,
	});

	it("lists the effective host and the limits of a custom provider", async () => {
		const snapshot = await snapshotOf();
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		expect(row(snapshot, "gateway")?.baseUrl).toEqual({ url: "https://old.example.com/v1", source: "models-json" });
		expect(row(snapshot, "gateway")?.customEdit?.models).toEqual([
			{ id: "fast", contextWindow: 32000, maxOutput: 4096 },
			{ id: "plain", contextWindow: 128000, maxOutput: 16384 },
		]);
		// Built-in providers have no custom edits.
		expect(row(snapshot, "anthropic")?.customEdit).toBeUndefined();
	});

	it("edits the host with the terminal's validation, keeping everything else", async () => {
		await writeConfigProvider({ action: "edit-host", provider: "gateway", host: "new.example.com/v2/" }, options());
		expect(readModels().providers.gateway).toMatchObject({
			baseUrl: "https://new.example.com/v2",
			apiKey: "!fake lookup gateway.models",
			name: "My gateway",
		});
		expect(readModels().providers.other.baseUrl).toBe("https://other.example.com/v1");
		for (const host of ["http://remote.example.com", "https://u:p@remote.example.com"]) {
			const error = await refusal(writeConfigProvider({ action: "edit-host", provider: "gateway", host }, options()));
			expect(error?.status, host).toBe(400);
			expect(error?.message).not.toContain("remote");
		}
		expect(readModels().providers.gateway.baseUrl).toBe("https://new.example.com/v2");
	});

	it("edits the limits of one model", async () => {
		await writeConfigProvider(
			{ action: "edit-limits", provider: "gateway", model: "plain", contextWindow: 200000, maxOutput: 8000 },
			options(),
		);
		expect(readModels().providers.gateway.models).toEqual([
			{ id: "fast", contextWindow: 32000, maxTokens: 4096 },
			{ id: "plain", contextWindow: 200000, maxTokens: 8000 },
		]);
		// The output cannot exceed the window, and the model must exist.
		expect(
			(
				await refusal(
					writeConfigProvider(
						{ action: "edit-limits", provider: "gateway", model: "fast", contextWindow: 1000, maxOutput: 2000 },
						options(),
					),
				)
			)?.status,
		).toBe(400);
		expect(
			(
				await refusal(
					writeConfigProvider(
						{ action: "edit-limits", provider: "gateway", model: "ghost", contextWindow: 1000, maxOutput: 100 },
						options(),
					),
				)
			)?.status,
		).toBe(404);
	});

	it("refuses an edit of a provider models.json does not define, built-in ones included", async () => {
		for (const provider of ["anthropic", "nowhere"]) {
			const error = await refusal(
				writeConfigProvider({ action: "edit-host", provider, host: "https://x.example.com" }, options()),
			);
			expect(error?.status, provider).toBe(404);
			expect((await refusal(writeConfigProvider({ action: "remove-custom", provider }, options())))?.status).toBe(404);
		}
	});

	it("removes a custom provider with its keychain entry and its saved credential", async () => {
		const keychain = fakeKeychain();
		await keychain.store(templateKeyAccount("gateway"), SECRET);
		fs.writeFileSync(
			modelsFile(),
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://old.example.com/v1",
						api: "openai-completions",
						apiKey: keychain.referenceFor(templateKeyAccount("gateway")),
						models: [{ id: "m" }],
					},
					other: { baseUrl: "https://other.example.com/v1", api: "openai-completions", models: [{ id: "m" }] },
				},
			}),
		);
		await writeConfigCredential({ action: "set", provider: "gateway", key: SECRET }, credentialOptions(keychain));
		expect(entryOf("gateway")).toBe(SECRET);
		await writeConfigProvider({ action: "remove-custom", provider: "gateway" }, options(keychain));
		expect(Object.keys(readModels().providers)).toEqual(["other"]);
		expect(entryOf(templateKeyAccount("gateway"))).toBeUndefined();
		expect(entryOf("gateway")).toBeUndefined();
		expect(readAuth().gateway).toBeUndefined();
	});

	it("leaves models.json alone when it has comments, naming what to change by hand", async () => {
		fs.writeFileSync(modelsFile(), `// mine\n${fs.readFileSync(modelsFile(), "utf8")}`);
		const error = await refusal(
			writeConfigProvider({ action: "edit-host", provider: "gateway", host: "https://new.example.com" }, options()),
		);
		expect(error?.status).toBe(409);
		expect(fs.readFileSync(modelsFile(), "utf8").startsWith("// mine")).toBe(true);
	});
});
