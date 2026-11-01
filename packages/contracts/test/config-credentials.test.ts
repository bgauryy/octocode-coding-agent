import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	ConfigCredentialCommandSchema,
	ConfigSnapshotSchema,
	ConfigSettingCommandSchema,
	ProviderIdSchema,
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
