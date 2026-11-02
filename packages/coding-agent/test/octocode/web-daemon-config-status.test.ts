import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSnapshotSchema, type ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeychainBackend } from "../../src/core/auth-storage/keychain.ts";
import { buildConfigSnapshot } from "../../src/octocode/web-daemon/config-status.ts";
import { trustFolder } from "./helpers.ts";

const SECRET = "SENTINEL-SECRET-4f9c";
const PROVIDER_VARS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"XAI_API_KEY",
	"GROQ_API_KEY",
];

let root: string;
let agentDir: string;
let marker: string;

/** A keychain whose references carry the sentinel, so any leak of reference text shows up. */
function fakeKeychain(): KeychainBackend {
	const reference = (provider: string) => `!fake-keychain lookup ${provider} ${SECRET}`;
	return {
		name: "Fake keychain",
		store: async () => {},
		remove: async () => {},
		referenceFor: reference,
		isOwnReference: (key, provider) => key === reference(provider),
	};
}

function writeAuth(data: unknown): void {
	fs.writeFileSync(path.join(agentDir, "auth.json"), typeof data === "string" ? data : JSON.stringify(data));
}
function provider(snapshot: ConfigSnapshot, id: string) {
	const found = snapshot.providers.find((row) => row.provider === id);
	if (!found) throw new Error(`no provider ${id}`);
	return found;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-status-"));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	marker = path.join(root, "command-ran");
	// Its own agent database: the suite's default one trusts the whole temp folder, which would trust every workspace here.
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	for (const name of PROVIDER_VARS) vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("credential sources", () => {
	it("classifies each source kind and never leaks a value or runs a command", async () => {
		const expires = Date.now() + 3_600_000;
		writeAuth({
			openai: { type: "api_key", key: SECRET },
			anthropic: { type: "api_key", key: fakeKeychain().referenceFor("anthropic") },
			groq: { type: "api_key", key: `!touch ${marker} && echo ${SECRET}` },
			"openai-codex": { type: "oauth", access: SECRET, refresh: SECRET, expires },
			mistral: { type: "api_key", key: "$CONFIG_STATUS_TEST_VAR" },
		});
		vi.stubEnv("CONFIG_STATUS_TEST_VAR", SECRET);
		const snapshot = await buildConfigSnapshot({
			agentDir,
			env: { XAI_API_KEY: SECRET },
			keychain: fakeKeychain(),
		});

		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		expect(provider(snapshot, "openai").sources).toEqual([{ kind: "auth-json" }]);
		expect(provider(snapshot, "anthropic")).toMatchObject({ configured: true, sources: [{ kind: "keychain" }] });
		expect(provider(snapshot, "groq").sources).toEqual([{ kind: "custom-command" }]);
		expect(provider(snapshot, "openai-codex").sources).toEqual([{ kind: "oauth", expiresAt: expires }]);
		expect(provider(snapshot, "mistral").sources).toEqual([{ kind: "env", envVar: "CONFIG_STATUS_TEST_VAR" }]);
		expect(provider(snapshot, "xai").sources).toEqual([{ kind: "env", envVar: "XAI_API_KEY" }]);
		expect(snapshot.keychainAvailable).toBe(true);

		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
		expect(JSON.stringify(snapshot)).not.toContain("touch");
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("marks a provider the credential endpoint would refuse as not editable, and no other", async () => {
		writeAuth({
			MyProvider: { type: "api_key", key: "x" },
			"my provider": { type: "api_key", key: "x" },
			constructor: { type: "api_key", key: "x" },
		});
		const snapshot = await buildConfigSnapshot({ agentDir, keychain: null });
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		expect(provider(snapshot, "MyProvider").editable).toBe(false);
		expect(provider(snapshot, "my provider").editable).toBe(false);
		// Every id the endpoint's schema accepts stays editable (the field is absent), built-in ones included.
		expect(snapshot.providers.filter((row) => row.editable === false).map((row) => row.provider)).toEqual([
			"MyProvider",
			"my provider",
		]);
		expect(provider(snapshot, "constructor").editable).toBeUndefined();
	});

	it("recognises a platform keychain reference without running it", async () => {
		writeAuth({
			openai: { type: "api_key", key: "!/usr/bin/security find-generic-password -s octocode -a openai -w" },
			groq: { type: "api_key", key: "!secret-tool lookup service octocode account groq" },
			// Another provider's reference is not this provider's own entry.
			xai: { type: "api_key", key: "!secret-tool lookup service octocode account groq" },
		});
		const snapshot = await buildConfigSnapshot({ agentDir, keychain: null });
		expect(provider(snapshot, "openai").sources).toEqual([{ kind: "keychain" }]);
		expect(provider(snapshot, "groq").sources).toEqual([{ kind: "keychain" }]);
		expect(provider(snapshot, "xai").sources).toEqual([{ kind: "custom-command" }]);
		expect(snapshot.keychainAvailable).toBe(false);
	});

	it("lists every source that is present without choosing one", async () => {
		writeAuth({ openai: { type: "api_key", key: SECRET }, anthropic: { type: "api_key", key: SECRET } });
		const snapshot = await buildConfigSnapshot({
			agentDir,
			env: { OPENAI_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: SECRET },
			keychain: null,
		});
		expect(provider(snapshot, "openai").sources).toEqual([
			{ kind: "auth-json" },
			{ kind: "env", envVar: "OPENAI_API_KEY" },
		]);
		expect(provider(snapshot, "anthropic").sources).toEqual([
			{ kind: "auth-json" },
			{ kind: "env", envVar: "ANTHROPIC_AUTH_TOKEN" },
			{ kind: "env", envVar: "ANTHROPIC_API_KEY" },
		]);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});

	it("skips signed-out OAuth, keyless entries and unset variable references", async () => {
		writeAuth({
			"openai-codex": { type: "oauth", access: "", refresh: "", expires: 0, signedOut: true },
			openai: { type: "api_key" },
			mistral: { type: "api_key", key: "${CONFIG_STATUS_UNSET_VAR}" },
		});
		const snapshot = await buildConfigSnapshot({ agentDir, keychain: null });
		for (const id of ["openai-codex", "openai", "mistral"]) {
			expect(provider(snapshot, id)).toMatchObject({ configured: false, sources: [] });
		}
	});

	it("reports an OAuth credential without an expiry as signed in", async () => {
		writeAuth({ "openai-codex": { type: "oauth", access: SECRET, refresh: SECRET, expires: 0 } });
		const snapshot = await buildConfigSnapshot({ agentDir, keychain: null });
		expect(provider(snapshot, "openai-codex").sources).toEqual([{ kind: "oauth" }]);
	});

	it("names providers by their display name and lists an unknown provider from auth.json last", async () => {
		writeAuth({ "my-gateway": { type: "api_key", key: SECRET } });
		const snapshot = await buildConfigSnapshot({ agentDir, keychain: null });
		expect(provider(snapshot, "openai").name).toBeTruthy();
		expect(snapshot.providers.at(-1)).toEqual({
			provider: "my-gateway",
			configured: true,
			sources: [{ kind: "auth-json" }],
		});
	});

	it("does not create auth.json or the agent directory", async () => {
		const missing = path.join(root, "missing-agent");
		const snapshot = await buildConfigSnapshot({ agentDir: missing, keychain: null });
		expect(fs.existsSync(missing)).toBe(false);
		expect(snapshot.providers.every((row) => !row.configured)).toBe(true);
		expect(snapshot.credentialsError).toBeUndefined();
	});

	it("reports an unreadable auth.json with fixed text that never quotes the file", async () => {
		writeAuth(`{ "openai": ${SECRET}`);
		const snapshot = await buildConfigSnapshot({ agentDir, env: { XAI_API_KEY: SECRET }, keychain: null });
		expect(snapshot.credentialsError).toMatch(/auth\.json could not be read/);
		expect(provider(snapshot, "xai").sources).toEqual([{ kind: "env", envVar: "XAI_API_KEY" }]);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});
});

describe("settings and trust", () => {
	function workspace(): string {
		const cwd = path.join(root, "repo");
		fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
		return cwd;
	}

	it("reports default when nothing is set and no workspace without a cwd", async () => {
		const snapshot = await buildConfigSnapshot({ agentDir, keychain: null });
		expect(snapshot.settings).toEqual([
			{ key: "defaultProvider", source: "default" },
			{ key: "defaultModel", source: "default" },
		]);
		expect(snapshot.workspace).toBeUndefined();
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
	});

	it("reads global settings and lets a trusted workspace override them", async () => {
		const cwd = workspace();
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-a" }),
		);
		fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), JSON.stringify({ defaultModel: "gpt-b" }));
		trustFolder(cwd);

		const snapshot = await buildConfigSnapshot({ agentDir, cwd, keychain: null });
		expect(snapshot.settings).toEqual([
			{ key: "defaultProvider", value: "openai", source: "global" },
			{ key: "defaultModel", value: "gpt-b", source: "workspace" },
		]);
		expect(snapshot.workspace).toEqual({ repo: "repo", trusted: true });
	});

	it("ignores workspace settings until the folder is trusted", async () => {
		const cwd = workspace();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "gpt-a" }));
		fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), JSON.stringify({ defaultModel: "gpt-b" }));

		const snapshot = await buildConfigSnapshot({ agentDir, cwd, keychain: null });
		expect(snapshot.settings[1]).toEqual({ key: "defaultModel", value: "gpt-a", source: "global" });
		expect(snapshot.workspace).toEqual({ repo: "repo", trusted: false });
		expect(snapshot.settingsErrors).toBeUndefined();
	});

	it("shows an invalid settings file as an error with fixed text and leaves it untouched", async () => {
		const cwd = workspace();
		const file = path.join(agentDir, "settings.json");
		const content = `{ "defaultProvider": ${SECRET}`;
		fs.writeFileSync(file, content);
		trustFolder(cwd);

		const snapshot = await buildConfigSnapshot({ agentDir, cwd, keychain: null });
		expect(snapshot.settingsErrors).toEqual([{ scope: "global", message: expect.stringContaining("invalid") }]);
		expect(snapshot.settings[0]).toEqual({ key: "defaultProvider", source: "default" });
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});
});
