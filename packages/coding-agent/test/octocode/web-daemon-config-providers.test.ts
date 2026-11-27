import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSnapshotSchema, type ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfigSnapshot } from "../../src/octocode/web-daemon/config-status.ts";
import { writeConfigProvider } from "../../src/octocode/web-daemon/provider-write.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const SECRET = "SENTINEL-SECRET-b81e";
let root: string;
let agentDir: string;
let piDir: string;
const cleanup: Array<() => Promise<void> | void> = [];

const write = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data));
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8"));
const settingsFile = () => path.join(agentDir, "settings.json");
const snapshotOf = (): Promise<ConfigSnapshot> =>
	buildConfigSnapshot({ agentDir, piDirs: [piDir], home: root, keychain: null, env: {} });
const row = (snapshot: ConfigSnapshot, id: string) => snapshot.providers.find((entry) => entry.provider === id);
const options = () => ({ agentDir, piDirs: [piDir], home: root, env: {}, actor: "web:test" });

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-providers-"));
	agentDir = path.join(root, "agent");
	piDir = path.join(root, ".pi", "agent");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(piDir, { recursive: true });
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"])
		vi.stubEnv(name, "");
	write(path.join(agentDir, "auth.json"), { "opencode-go": { type: "api_key", key: SECRET } });
	write(path.join(piDir, "models.json"), {
		providers: {
			openai: { apiKey: SECRET },
			"guy-provider-anthropic-x": {
				baseUrl: "https://example.test/v1",
				api: "anthropic-messages",
				apiKey: SECRET,
				models: [{ id: "m" }],
			},
			"keyless-local": { baseUrl: "http://localhost:1/v1", api: "openai-completions", models: [{ id: "m" }] },
		},
	});
	write(path.join(piDir, "auth.json"), { anthropic: { type: "api_key", key: SECRET } });
});
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const fn of cleanup.splice(0).reverse()) await fn();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("providers from configuration", () => {
	it("serializes public plan terms and billing beside credential methods", async () => {
		const snapshot = await snapshotOf();
		expect(row(snapshot, "opencode-go")?.auth?.plan).toMatchObject({
			billing: "plan",
			terms: expect.stringMatching(/^https:\/\//),
		});
		expect(row(snapshot, "amazon-bedrock")?.auth?.keyAuth?.name).toBe("AWS credentials or bearer token");
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});
	it("keeps a valid Pi entry visible when another entry is malformed", async () => {
		write(path.join(piDir, "auth.json"), { anthropic: { type: "api_key", key: SECRET }, invalid: 0 });
		const snapshot = await snapshotOf();
		expect(snapshot.credentialsError).toMatch(/Pi credentials/);
		expect(row(snapshot, "anthropic")?.configured).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});

	it("offers custom models beyond the compact provider summary when selecting a preference", async () => {
		const models = Array.from({ length: 70 }, (_, i) => ({ id: `model-${i}` }));
		write(path.join(agentDir, "models.json"), {
			providers: { large: { models, api: "openai-completions", apiKey: SECRET } },
		});
		expect(row(await snapshotOf(), "large")?.modelChoice?.ids).toContain("model-69");
		await writeConfigProvider({ action: "set-provider-model", provider: "large", model: "model-69" }, options());
		expect(row(await snapshotOf(), "large")?.modelChoice?.preferred).toBe("model-69");
	});
	it("saves a provider and its preferred model independently and rejects unavailable choices", async () => {
		const provider = "guy-provider-anthropic-x";
		await writeConfigProvider({ action: "set-provider-model", provider, model: "m" }, options());
		await writeConfigProvider({ action: "set-default-provider", provider }, options());
		expect(row(await snapshotOf(), provider)?.modelChoice).toMatchObject({ defaultProvider: true, preferred: "m" });
		await expect(
			writeConfigProvider({ action: "set-provider-model", provider, model: "absent" }, options()),
		).rejects.toThrow(/visible model/);
		await writeConfigProvider({ action: "set-provider-model", provider, model: null }, options());
		expect(row(await snapshotOf(), provider)?.modelChoice).not.toHaveProperty("preferred");
		expect(row(await snapshotOf(), provider)?.modelChoice?.defaultProvider).toBe(true);
	});

	it("reports the winning model definition when a lower-priority file also has a key", async () => {
		write(path.join(agentDir, "models.json"), {
			providers: {
				"model-only": { models: [{ id: "m" }] },
				"unset-key": { apiKey: "$OCTOCODE_MISSING_TEST_KEY" },
			},
		});
		write(path.join(piDir, "models.json"), {
			providers: {
				"model-only": { apiKey: SECRET },
				"unset-key": { apiKey: SECRET },
			},
		});
		write(path.join(piDir, "auth.json"), { "unset-key": { type: "api_key", key: SECRET } });
		const snapshot = await snapshotOf();
		expect(row(snapshot, "model-only")?.configured).toBe(false);
		expect(row(snapshot, "unset-key")?.configured).toBe(false);
	});

	it("shows only usable inherited credentials and honors a local sign-out", async () => {
		write(path.join(agentDir, "auth.json"), {
			openai: { type: "oauth", access: "", refresh: "", expires: 0, signedOut: true },
		});
		write(path.join(piDir, "auth.json"), {
			openai: { type: "api_key", key: SECRET },
			anthropic: { type: "oauth", access: "fixture", refresh: "fixture", expires: 1 },
			cerebras: { type: "api_key", key: "!fixture-helper" },
			groq: { type: "api_key", key: "$OCTOCODE_MISSING_TEST_KEY" },
		});
		const snapshot = await snapshotOf();
		for (const id of ["openai", "anthropic", "cerebras", "groq"]) {
			expect(row(snapshot, id)?.configured, id).toBe(false);
		}
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});

	it("lists Pi's models.json and auth.json providers with their origin and never a value", async () => {
		const snapshot = await snapshotOf();
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
		// An official id in Pi's models.json is skipped (models.json is for custom providers only): no key, no origin.
		expect(row(snapshot, "openai")).toMatchObject({ configured: false });
		expect(row(snapshot, "openai")?.origins).toBeUndefined();
		expect(row(snapshot, "guy-provider-anthropic-x")).toMatchObject({
			configured: true,
			origins: [{ product: "pi", file: "models-json", hasKey: true }],
		});
		expect(row(snapshot, "anthropic")).toMatchObject({
			configured: true,
			origins: [{ product: "pi", file: "auth-json" }],
		});
		expect(row(snapshot, "opencode-go")).toMatchObject({
			configured: true,
			origins: [{ product: "octocode", file: "auth-json" }],
		});
		// Defined, but no key: listed with its origin, not configured.
		expect(row(snapshot, "keyless-local")).toMatchObject({
			configured: false,
			origins: [{ product: "pi", file: "models-json", hasKey: false }],
		});
	});

	it("shows Octocode's own models.json and the sources", async () => {
		write(path.join(agentDir, "models.json"), {
			providers: { "own-provider": { apiKey: SECRET, models: [{ id: "m" }] } },
		});
		const snapshot = await snapshotOf();
		expect(row(snapshot, "own-provider")).toMatchObject({
			origins: [{ product: "octocode", file: "models-json", hasKey: true }],
		});
		expect(snapshot.sources).toEqual([
			{ id: "octocode", label: "Octocode", enabled: true, toggleable: false, present: true },
			{ id: "pi", label: "Pi", enabled: true, toggleable: true, present: true },
		]);
	});

	it("names a models.json-only provider, lists its models and counts an unset key variable as not configured", async () => {
		write(path.join(agentDir, "models.json"), {
			providers: {
				acme: {
					name: "Acme Gateway",
					baseUrl: "https://acme.example/v1",
					api: "openai-completions",
					apiKey: "$ACME_GATEWAY_KEY",
					models: [{ id: "acme-large" }, { id: "acme-small" }],
				},
			},
		});
		const unset = row(await snapshotOf(), "acme");
		expect(unset).toMatchObject({
			name: "Acme Gateway",
			models: ["acme-large", "acme-small"],
			configured: false,
			origins: [{ product: "octocode", file: "models-json", hasKey: true, keyUnset: true }],
		});
		const set = await buildConfigSnapshot({
			agentDir,
			piDirs: [piDir],
			home: root,
			keychain: null,
			env: { ACME_GATEWAY_KEY: "x" },
		});
		expect(row(set, "acme")?.configured).toBe(true);
		expect(row(set, "acme")?.origins?.[0]?.keyUnset).toBeUndefined();
	});

	it("reports where models.json lives", async () => {
		expect((await snapshotOf()).modelsPath).toBe(path.join(agentDir, "models.json"));
	});

	it("hides Pi's providers while the Pi source is off and restores them when it is on again", async () => {
		await writeConfigProvider({ action: "set-source", source: "pi", enabled: false }, options());
		expect(readJson(settingsFile())).toEqual({ providerSources: { pi: false } });
		const off = await snapshotOf();
		expect(off.sources?.find((source) => source.id === "pi")).toMatchObject({ enabled: false });
		expect(row(off, "guy-provider-anthropic-x")).toBeUndefined();
		expect(row(off, "anthropic")?.origins).toBeUndefined();
		expect(row(off, "opencode-go")?.configured).toBe(true);

		await writeConfigProvider({ action: "set-source", source: "pi", enabled: true }, options());
		expect(readJson(settingsFile()).providerSources).toEqual({});
		expect(row(await snapshotOf(), "guy-provider-anthropic-x")?.configured).toBe(true);
	});

	it("reports an unreadable models.json with fixed text", async () => {
		fs.writeFileSync(path.join(piDir, "models.json"), `{ "providers": ${SECRET}`);
		const snapshot = await snapshotOf();
		expect(snapshot.credentialsError).toBe("A models.json file could not be read; its providers are not shown.");
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});
});

describe("writeConfigProvider", () => {
	it("disables a provider into disabledProviders, keeps its credentials and re-enabling clears it", async () => {
		const audit = vi.fn();
		await writeConfigProvider(
			{ action: "set-provider", provider: "guy-provider-anthropic-x", enabled: false },
			{ ...options(), audit },
		);
		await writeConfigProvider({ action: "set-provider", provider: "opencode-go", enabled: false }, options());
		expect(readJson(settingsFile()).disabledProviders).toEqual(["guy-provider-anthropic-x", "opencode-go"]);
		expect(readJson(path.join(agentDir, "auth.json"))).toHaveProperty("opencode-go");
		const snapshot = await snapshotOf();
		expect(row(snapshot, "opencode-go")).toMatchObject({ disabled: true, configured: true });
		expect(row(snapshot, "openai")?.disabled).toBeUndefined();
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "provider.toggle",
				target: "guy-provider-anthropic-x",
				afterKind: "off",
				outcome: "ok",
			}),
		);

		await writeConfigProvider({ action: "set-provider", provider: "opencode-go", enabled: true }, options());
		expect(readJson(settingsFile()).disabledProviders).toEqual(["guy-provider-anthropic-x"]);
		await writeConfigProvider(
			{ action: "set-provider", provider: "guy-provider-anthropic-x", enabled: true },
			options(),
		);
		expect(readJson(settingsFile()).disabledProviders).toEqual([]);
	});

	it("refuses an unknown provider and an invalid settings file without writing", async () => {
		const audit = vi.fn();
		await expect(
			writeConfigProvider({ action: "set-provider", provider: "nope", enabled: false }, { ...options(), audit }),
		).rejects.toMatchObject({ status: 404 });
		expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused", errorCode: "unknown" }));
		expect(fs.existsSync(settingsFile())).toBe(false);
		fs.writeFileSync(settingsFile(), `{ broken ${SECRET}`);
		const error = await writeConfigProvider({ action: "set-source", source: "pi", enabled: false }, options()).catch(
			(caught: Error) => caught,
		);
		expect(error).toMatchObject({ status: 409 });
		expect((error as Error).message).not.toContain(SECRET);
		expect(fs.readFileSync(settingsFile(), "utf8")).toContain("broken");
	});
});

describe("POST /api/admin/config/providers", () => {
	async function daemon() {
		const { env } = isolatedEnv();
		const server: DaemonServer = await startDaemonServer({
			env,
			onActivity: () => {},
			config: () => snapshotOf(),
			writeProvider: (command) => writeConfigProvider(command, options()),
			onDrain: () => {},
		});
		cleanup.push(() => server.close());
		const call = (token: string, body: unknown) =>
			fetch(`http://127.0.0.1:${server.port}/api/admin/config/providers`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		return { server, call };
	}

	it("changes a switch for the launch token and answers with the fresh snapshot", async () => {
		const { server, call } = await daemon();
		const response = await call(server.token, { action: "set-provider", provider: "openai", enabled: false });
		expect(response.status).toBe(200);
		const body = (await response.json()) as ConfigSnapshot;
		expect(row(body, "openai")?.disabled).toBe(true);
		expect(JSON.stringify(body)).not.toContain(SECRET);
		expect((await call(server.token, { action: "set-source", source: "pi", enabled: false })).status).toBe(200);
		expect(readJson(settingsFile())).toEqual({ disabledProviders: ["openai"], providerSources: { pi: false } });
	});

	it("refuses published links and invalid commands", async () => {
		const { server, call } = await daemon();
		const good = { action: "set-provider", provider: "openai", enabled: false };
		expect((await call(server.remoteToken, good)).status).toBe(403);
		expect((await call(server.viewToken, good)).status).toBe(403);
		for (const bad of [
			{ ...good, enabled: "no" },
			{ ...good, provider: "Bad Id" },
			{ action: "set-source", source: "octocode", enabled: false },
			{ action: "set-source", source: "copilot-env", enabled: true },
			{ ...good, extra: true },
		])
			expect((await call(server.token, bad)).status).toBe(400);
		expect(fs.existsSync(settingsFile())).toBe(false);
	});
});
