import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	ConfigCredentialCommandSchema,
	ConfigSnapshotSchema,
	ConfigSettingCommandSchema,
	ProviderIdSchema,
	SignInCommandSchema,
	SignInStateSchema,
} from "../src/config.ts";

describe("ConfigCredentialCommandSchema", () => {
	it("accepts a set with a key and a clear without one", () => {
		expect(Value.Check(ConfigCredentialCommandSchema, { action: "set", provider: "openai", key: "sk-1" })).toBe(true);
		expect(
			Value.Check(ConfigCredentialCommandSchema, {
				action: "set",
				provider: "openai",
				key: "sk-1",
				acknowledgePlaintext: true,
			}),
		).toBe(true);
		expect(Value.Check(ConfigCredentialCommandSchema, { action: "clear", provider: "openai" })).toBe(true);
	});

	it("refuses a missing, empty, oversized or control-character key, a bad provider and extra fields", () => {
		const ok = { action: "set", provider: "openai", key: "sk-1" };
		for (const bad of [
			{ action: "set", provider: "openai" },
			{ ...ok, key: "" },
			{ ...ok, key: "a".repeat(8193) },
			{ ...ok, key: "a\nb" },
			{ ...ok, provider: "Open AI" },
			{ ...ok, extra: 1 },
			{ action: "clear", provider: "openai", key: "sk-1" },
		])
			expect(Value.Check(ConfigCredentialCommandSchema, bad), JSON.stringify(bad)).toBe(false);
	});

	it("names provider ids that the keychain and the page agree on", () => {
		for (const id of ["openai", "amazon-bedrock", "my.provider_2", "constructor"])
			expect(Value.Check(ProviderIdSchema, id), id).toBe(true);
		for (const id of ["", "MyProvider", "my provider", "-x", "a/b", "a\nb"])
			expect(Value.Check(ProviderIdSchema, id), JSON.stringify(id)).toBe(false);
	});

	it("is the only configuration schema that carries a key, and no read model has a secret-shaped field", () => {
		/** Every property name declared anywhere in a schema. */
		const names = (schema: unknown, found = new Set<string>()): Set<string> => {
			if (schema && typeof schema === "object") {
				for (const [name, value] of Object.entries(schema)) {
					if (name === "properties" && value && typeof value === "object")
						Object.keys(value).forEach((key) => found.add(key));
					names(value, found);
				}
			}
			return found;
		};
		const hasKeyField = (schema: unknown): boolean => names(schema).has("key");
		expect(hasKeyField(ConfigCredentialCommandSchema)).toBe(true);
		// `key` also names a setting in the snapshot and the settings command; the secret-shaped names are the test.
		for (const schema of [ConfigSnapshotSchema, ConfigSettingCommandSchema])
			expect([...names(schema)].filter((name) => /secret|apikey|password|token|plaintext/i.test(name))).toEqual([]);
	});
});

describe("sign-in schemas", () => {
	it("accepts the four commands and refuses a bad provider, a missing answer or extra fields", () => {
		for (const ok of [
			{ action: "start", provider: "openai-codex" },
			{ action: "status", provider: "openai-codex" },
			{ action: "cancel", provider: "openai-codex" },
			{ action: "answer", provider: "openai-codex", promptId: "p1", value: "code" },
		])
			expect(Value.Check(SignInCommandSchema, ok), JSON.stringify(ok)).toBe(true);
		for (const bad of [
			{ action: "start", provider: "Bad Id" },
			{ action: "answer", provider: "openai", promptId: "p1" },
			{ action: "answer", provider: "openai", promptId: "p1", value: "a\nb" },
			{ action: "start", provider: "openai", key: "sk-1" },
		])
			expect(Value.Check(SignInCommandSchema, bad), JSON.stringify(bad)).toBe(false);
	});

	it("allows only web links in a state and no credential field", () => {
		const base = { provider: "openai", status: "running", events: [] };
		expect(
			Value.Check(SignInStateSchema, { ...base, events: [{ type: "auth_url", url: "https://example.com/a" }] }),
		).toBe(true);
		expect(
			Value.Check(SignInStateSchema, { ...base, events: [{ type: "auth_url", url: "javascript:alert(1)" }] }),
		).toBe(false);
		expect(Value.Check(SignInStateSchema, { ...base, token: "x" })).toBe(false);
	});

	it("accepts a key page only as https", () => {
		const row = (keyPage: string) => ({
			provider: "openai",
			configured: false,
			sources: [],
			auth: { keyAuth: { name: "OpenAI API key", keyPage } },
		});
		const snapshot = (keyPage: string) => ({
			protocolVersion: 1,
			generatedAt: 1,
			keychainAvailable: true,
			providers: [row(keyPage)],
			settings: [],
		});
		expect(Value.Check(ConfigSnapshotSchema, snapshot("https://platform.openai.com/api-keys"))).toBe(true);
		expect(Value.Check(ConfigSnapshotSchema, snapshot("http://example.com"))).toBe(false);
	});
});
