import { describe, expect, it } from "vitest";
import { redactSecrets, secretProblem } from "../src/sanitize.ts";

describe("credentials in a URL inside text", () => {
	it.each([
		["fetch failed https://h.example/v1?key=abc&x=1", "key=abc"],
		["GET https://h.example/v1?mode=a&api_key=short1 failed", "short1"],
		["https://h.example/cb?access_token=zz9&state=1", "zz9"],
		["https://h.example/cb?clientSecret=zz9", "zz9"],
		["https://h.example/p?sig=abc", "sig=abc"],
	])("removes the value in %s", (text, secret) => {
		const out = redactSecrets(text);
		expect(out).not.toContain(secret);
		expect(out).toContain("h.example");
		expect(secretProblem(text)).toBeDefined();
	});

	it("keeps the user name and password of a URL out too", () => {
		expect(redactSecrets("fetch https://user:s3cretpass@host/v1 failed")).not.toContain("s3cretpass");
	});

	it.each([
		"https://h.example/v1?token_type=bearer",
		"https://h.example/search?q=keyword&page=2",
		"see https://h.example/design?size=3",
	])("leaves %s alone", (text) => {
		expect(redactSecrets(text)).toBe(text);
	});
});
