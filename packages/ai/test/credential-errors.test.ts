import { describe, expect, it } from "vitest";
import { isCredentialError, isModelAccessError, isRetryableErrorText } from "../src/utils/retry.ts";

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

describe("model access at the selected account and endpoint", () => {
	it.each([
		'AccessDeniedException: 403 {"message":"zai.glm-5.3 is not available for this account."}',
		'AccessDeniedException: 403 {"message":"This model is not available for this account."}',
		'Validation error: 400 {"message":"The provided model identifier is invalid."}',
		"404 model_not_found",
		"You don't have access to the model with the specified model ID",
		"403 Access to this model is denied",
		"Invocation of model ID with on-demand throughput isn't supported. Please retry your request with an inference profile.",
		"This account is not approved for this model.",
		"The model compact does not exist or you do not have access to it.",
	])("recognizes %s without rejecting the credential", (message) => {
		expect(isModelAccessError(message)).toBe(true);
		expect(isRetryableErrorText(message)).toBe(false);
		expect(isCredentialError(message)).toBe(false);
	});

	it.each([
		"401 Model is not available for this account: unauthorized",
		"403 Invalid token; no access to model m",
		"403 forbidden",
		"429 Rate limit reached on this model",
		"503 Model is temporarily unavailable",
		"The data retention mode 'default' is not available for this model",
		"400 Invalid parameter: reasoning_effort for model m",
		"400 Invalid account identifier",
	])("does not hide a model for %s", (message) => {
		expect(isModelAccessError(message)).toBe(false);
	});
});
