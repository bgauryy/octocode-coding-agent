import { describe, expect, it } from "vitest";
import { isCredentialError } from "../src/utils/retry.ts";

describe("isCredentialError", () => {
	it.each([
		"OAuth refresh failed for openai (400 invalid_grant)",
		"OpenAI OAuth token request failed (400 invalid_grant); the ChatGPT sign-in expired or was revoked",
		"401 Unauthorized",
		"invalid api key",
		"403 Forbidden",
	])("counts %s as a refused credential", (text) => {
		expect(isCredentialError(text)).toBe(true);
	});

	it.each([
		"403 this model is not available for your account",
		"503 overloaded_error: Overloaded",
		"400 invalid_request_error: bad field",
	])("does not count %s", (text) => {
		expect(isCredentialError(text)).toBe(false);
	});
});
