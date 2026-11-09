import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	CONFIG_PROTOCOL_VERSION,
	ConfigProviderCommandSchema,
	ConfigSettingCommandSchema,
	ConfigSnapshotSchema,
	CREDENTIAL_SOURCES,
	CredentialSourceSchema,
	ProviderCredentialStatusSchema,
	type ConfigSnapshot,
} from "../src/config.ts";

const snapshot: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: 1_000,
	keychainAvailable: true,
	providers: [
		{
			provider: "openai",
			name: "OpenAI",
			configured: true,
			sources: [{ kind: "keychain" }, { kind: "env", envVar: "OPENAI_API_KEY" }],
		},
		{ provider: "anthropic", configured: true, sources: [{ kind: "oauth", expiresAt: 2_000 }] },
		{ provider: "groq", name: "Groq", configured: false, sources: [] },
	],
	settings: [
		{ key: "defaultProvider", value: "openai", source: "global" },
		{ key: "defaultModel", source: "default" },
	],
	workspace: { repo: "octo", trusted: false },
};

describe("config schemas", () => {
	it("accepts a snapshot with every source kind, an unset setting and a workspace", () => {
		expect(Value.Check(ConfigSnapshotSchema, snapshot)).toBe(true);
		for (const kind of CREDENTIAL_SOURCES) expect(Value.Check(CredentialSourceSchema, kind)).toBe(true);
		expect(Value.Check(ConfigSnapshotSchema, { ...snapshot, workspace: undefined })).toBe(true);
	});

	it("rejects an unknown kind, a missing field and another protocol version", () => {
		expect(Value.Check(CredentialSourceSchema, "runtime")).toBe(false);
		expect(Value.Check(ProviderCredentialStatusSchema, { provider: "openai", sources: [] })).toBe(false);
		expect(Value.Check(ConfigSnapshotSchema, { ...snapshot, protocolVersion: 2 })).toBe(false);
		expect(Value.Check(ConfigSnapshotSchema, { ...snapshot, settings: [{ key: "x", source: "env" }] })).toBe(false);
	});

	it("has no field that could carry a secret", () => {
		const withKey = (extra: Record<string, unknown>) => ({
			...snapshot,
			providers: [{ provider: "openai", configured: true, sources: [{ kind: "auth-json", ...extra }] }],
		});
		expect(Value.Check(ConfigSnapshotSchema, withKey({}))).toBe(true);
		expect(Value.Check(ConfigSnapshotSchema, withKey({ key: "sk-secret" }))).toBe(false);
		expect(Value.Check(ConfigSnapshotSchema, withKey({ reference: "!pass show openai" }))).toBe(false);
		expect(Value.Check(ConfigSnapshotSchema, { ...snapshot, apiKey: "sk-secret" })).toBe(false);
		expect(
			Value.Check(ProviderCredentialStatusSchema, { provider: "openai", configured: true, sources: [], key: "sk" }),
		).toBe(false);
	});

	it("limits an environment variable field to a variable name", () => {
		const env = (envVar: string) => ({
			provider: "openai",
			configured: true,
			sources: [{ kind: "env", envVar }],
		});
		expect(Value.Check(ProviderCredentialStatusSchema, env("OPENAI_API_KEY"))).toBe(true);
		expect(Value.Check(ProviderCredentialStatusSchema, env("sk-proj-abc123"))).toBe(false);
		expect(Value.Check(ProviderCredentialStatusSchema, env("my key value"))).toBe(false);
	});

	it("validates settings file errors as a fixed scope and a short message", () => {
		const error = { scope: "workspace", message: "Invalid settings file" };
		expect(Value.Check(ConfigSnapshotSchema, { ...snapshot, settingsErrors: [error] })).toBe(true);
		expect(Value.Check(ConfigSnapshotSchema, { ...snapshot, settingsErrors: [{ ...error, scope: "project" }] })).toBe(
			false,
		);
	});

	it("accepts a setting change only for an allow-listed key and a file the page can write", () => {
		const command = { key: "defaultModel", scope: "workspace", value: "gpt-5", repoId: "abc123" };
		expect(Value.Check(ConfigSettingCommandSchema, command)).toBe(true);
		expect(Value.Check(ConfigSettingCommandSchema, { ...command, value: null })).toBe(true);
		for (const bad of [
			{ ...command, key: "packages" },
			{ ...command, scope: "default" },
			{ ...command, value: "" },
			{ ...command, value: "a\nb" },
			{ ...command, value: "x".repeat(257) },
			{ ...command, repoId: "../etc" },
			{ ...command, extra: 1 },
		])
			expect(Value.Check(ConfigSettingCommandSchema, bad), JSON.stringify(bad)).toBe(false);
	});
});

describe("provider origins, sources and commands", () => {
	it("accepts origins, a disabled flag and sources, and rejects extra fields", () => {
		const row = {
			provider: "openai",
			configured: true,
			sources: [],
			origins: [{ product: "pi", file: "models-json", hasKey: true }],
			disabled: true,
		};
		expect(Value.Check(ProviderCredentialStatusSchema, row)).toBe(true);
		expect(
			Value.Check(ProviderCredentialStatusSchema, { ...row, origins: [{ product: "claude", file: "auth-json" }] }),
		).toBe(false);
		expect(
			Value.Check(ProviderCredentialStatusSchema, {
				...row,
				origins: [{ product: "pi", file: "auth-json", key: "x" }],
			}),
		).toBe(false);
		const withSources = {
			...snapshot,
			sources: [{ id: "pi", label: "Pi", enabled: true, toggleable: true, present: false }],
		};
		expect(Value.Check(ConfigSnapshotSchema, withSources)).toBe(true);
	});

	it("accepts only a provider or the Pi source as a provider command", () => {
		const ok = [
			{ action: "set-provider", provider: "openai", enabled: false },
			{ action: "set-source", source: "pi", enabled: true },
		];
		for (const command of ok) expect(Value.Check(ConfigProviderCommandSchema, command)).toBe(true);
		for (const bad of [
			{ action: "set-source", source: "octocode", enabled: false },
			{ action: "set-source", source: "copilot-env", enabled: true },
			{ action: "set-provider", provider: "Bad Id", enabled: true },
			{ action: "set-provider", provider: "openai" },
			{ action: "set-provider", provider: "openai", enabled: true, extra: 1 },
		])
			expect(Value.Check(ConfigProviderCommandSchema, bad)).toBe(false);
	});
});
