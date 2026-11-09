import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	listPiProviderCredentials,
	listPiModelProviders,
	readPiProviderCredential,
} from "../src/core/auth-storage/pi.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { getAgentDir, getModelsPath } from "../src/config.ts";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit Pi provider import", () => {
	it("does not disclose credential fragments from malformed JSON", async () => {
		const root = fixture();
		const authPath = join(root, "auth.json");
		writeFileSync(authPath, '{"openai":{"type":"api_key","key":sk-private-fixture}}');
		await expect(listPiProviderCredentials([root])).rejects.not.toThrow("sk-private-fixture");
		await expect(readPiProviderCredential({ providerId: "openai", type: "api_key", authPath })).rejects.not.toThrow(
			"sk-private-fixture",
		);
	});
	it("discovers Pi models.json providers even without saved sign-ins", async () => {
		const root = fixture();
		const path = join(root, "models.json");
		writeFileSync(path, JSON.stringify({ providers: { openai: { apiKey: "OPENAI_API_KEY" } } }));
		expect(await listPiProviderCredentials([root])).toEqual([]);
		expect(await listPiModelProviders([root])).toEqual(new Map([["openai", path]]));
	});
	it("attributes each provider to the models.json that defines it, not Octocode's merged view of Pi's", async () => {
		// The suite's empty HOME sets no override, so Pi discovery is on, as on a real machine.
		const home = homedir();
		const piDir = join(home, ".pi", "agent");
		mkdirSync(piDir, { recursive: true });
		mkdirSync(getAgentDir(), { recursive: true });
		roots.push(join(home, ".pi"), getAgentDir());
		writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { "pi-only": { apiKey: "PI_KEY" } } }));
		writeFileSync(getModelsPath(), JSON.stringify({ providers: { own: { apiKey: "OWN_KEY" } } }));
		// Loading Octocode's file merges Pi's, which is what made /providers name the wrong file.
		expect((await ModelConfig.load(getModelsPath())).getProviderIds()).toEqual(
			expect.arrayContaining(["own", "pi-only"]),
		);
		expect(await listPiModelProviders([getAgentDir()])).toEqual(new Map([["own", getModelsPath()]]));
		expect(await listPiModelProviders([piDir])).toEqual(new Map([["pi-only", join(piDir, "models.json")]]));
	});
	it("lists metadata with Pi agent directory precedence and never resolves commands", async () => {
		const root = fixture();
		const agent = join(root, "agent");
		mkdirSync(agent);
		writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "!exit 99" } }));
		writeFileSync(join(root, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fallback" } }));
		const entries = await listPiProviderCredentials([agent, root]);
		expect(entries).toEqual([{ providerId: "openai", type: "api_key", authPath: join(agent, "auth.json") }]);
		await expect(readPiProviderCredential(entries[0])).rejects.toThrow("command was not executed");
	});

	it("keeps automatic discovery disabled for explicit homes", async () => {
		vi.stubEnv("OCTOCODE_HOME", fixture());
		expect(await listPiProviderCredentials()).toEqual([]);
	});

	it("preserves environment references in file imports without evaluating the secret twice", async () => {
		const root = fixture();
		const authPath = join(root, "auth.json");
		const raw = { type: "api_key" as const, key: "$PI_IMPORT_KEY" };
		writeFileSync(authPath, JSON.stringify({ openai: raw }));
		vi.stubEnv("PI_IMPORT_KEY", "fixture-$unexpanded-suffix");
		const [entry] = await listPiProviderCredentials([root]);
		const credential = await readPiProviderCredential(entry);
		expect(credential).toEqual(raw);
		const storage = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
		await runtime.importCredential(entry.providerId, credential);
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "fixture-$unexpanded-suffix" });
		expect(await storage.modify("openai", async (current) => current)).toEqual(raw);
		await expect(readPiProviderCredential(entry, true)).resolves.toEqual({
			type: "api_key",
			key: "fixture-$unexpanded-suffix",
		});
	});

	it("rejects unresolved keys for keychain imports while preserving references for file imports", async () => {
		const root = fixture();
		const authPath = join(root, "auth.json");
		const raw = { type: "api_key" as const, key: "$PI_MISSING_IMPORT_KEY" };
		writeFileSync(authPath, JSON.stringify({ openai: raw }));
		vi.stubEnv("PI_MISSING_IMPORT_KEY", undefined);
		const [entry] = await listPiProviderCredentials([root]);
		await expect(readPiProviderCredential(entry, true)).rejects.toThrow("could not be resolved");
		await expect(readPiProviderCredential(entry)).resolves.toEqual(raw);
		writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", env: { PROFILE: "fixture" } } }));
		await expect(readPiProviderCredential(entry, true)).rejects.toThrow("could not be resolved");
	});

	it("imports an API key, derives real provider models, and leaves Pi unchanged", async () => {
		const root = fixture();
		const authPath = join(root, "auth.json");
		const data = JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } });
		writeFileSync(authPath, data);
		const [entry] = await listPiProviderCredentials([root]);
		const credential = await readPiProviderCredential(entry);
		const storage = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
		await runtime.importCredential(entry.providerId, credential);
		expect(await storage.read("openai")).toEqual(credential);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "openai")).toBe(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "pi")).toBe(false);
		expect(readFileSync(authPath, "utf8")).toBe(data);
		await runtime.logout("openai");
		expect(await storage.read("openai")).toBeUndefined();
		expect(readFileSync(authPath, "utf8")).toBe(data);
	});

	it("does not overwrite existing credentials after cancellation or failed secure storage", async () => {
		const storage = AuthStorage.inMemory({ openai: { type: "api_key", key: "old" } });
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
		const credential = { type: "api_key" as const, key: "new" };
		await expect(runtime.importCredential("openai", credential, { signal: AbortSignal.abort() })).rejects.toThrow();
		await expect(
			runtime.importCredential(
				"openai",
				credential,
				{},
				{
					transformCredential: async () => {
						throw new Error("keychain unavailable");
					},
				},
			),
		).rejects.toThrow();
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "old" });
	});
});
