import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/sanitize.ts";

describe("a password in a URL", () => {
	it.each([
		["fetch https://user:s3cretpass@host/v1 failed", "s3cretpass"],
		["postgres://admin:hunter22@db:5432/x", "hunter22"],
		["git+ssh://me:tok3n@github.com/a/b", "tok3n"],
		["X-1.2://u:pass@h", "pass"],
	])("redacts %s", (text, secret) => {
		expect(redactSecrets(text)).not.toContain(secret);
	});

	it.each(["https://user:${PASSWORD}@host/", "https://user:<password>@host/"])("passes template %s through", (text) => {
		expect(redactSecrets(text)).toBe(text);
	});

	it.each(["a.", "a+"])("scans a 64 KB run of %s in linear time", (unit) => {
		const text = unit.repeat(32_000);
		const start = performance.now();
		redactSecrets(text);
		expect(performance.now() - start).toBeLessThan(50);
	});
});

describe("a password assignment", () => {
	it("scans a 64 KB run of assignments in linear time", () => {
		const start = performance.now();
		redactSecrets("password=".repeat(8_000));
		expect(performance.now() - start).toBeLessThan(50);
	});

	it("still redacts a value with a digit", () => {
		expect(redactSecrets("password = s3cretValue")).not.toContain("s3cretValue");
	});
});
