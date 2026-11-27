import { describe, expect, it } from "vitest";
import { isCredentialError, isModelAccessError, isRetryableErrorText } from "../src/utils/retry.ts";

describe("isCredentialError", () => {
	it.each([
		"OAuth refresh failed for openai (400 invalid_grant)",
		"OpenAI OAuth token request failed (400 invalid_grant); the ChatGPT sign-in expired or was revoked",
		"401 Unauthorized",
		"invalid api key",
	])("counts %s as a refused credential", (text) => {
		expect(isCredentialError(text)).toBe(true);
	});

	it.each([
		"403 this model is not available for your account",
		"503 overloaded_error: Overloaded",
		"400 invalid_request_error: bad field",
		// A bare 403 names no credential: a region, a policy or a gateway refuses as often as a key does.
		"403 Forbidden",
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

/** Real error bodies, as the adapters put them in `errorMessage` (status first, then the provider's body or message). */
const REFUSED_CREDENTIALS: [vendor: string, body: string][] = [
	["Anthropic", '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
	["Anthropic", "401 invalid x-api-key"],
	[
		"Anthropic",
		'401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
	],
	[
		"Anthropic",
		'403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}',
	],
	[
		"OpenAI",
		"401 Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.",
	],
	["OpenAI", "invalid_api_key"],
	["OpenAI", "401 Your authentication token has been invalidated. Please try signing in again."],
	["OpenAI", "OpenAI OAuth token request failed (400 invalid_grant); the ChatGPT sign-in expired or was revoked"],
	["Bedrock", "ExpiredTokenException: The security token included in the request is expired"],
	["Bedrock", "UnrecognizedClientException: The security token included in the request is invalid."],
	["Bedrock", "Could not load credentials from any providers"],
	["Bedrock", "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile."],
	["Bedrock", "Your session has expired. Please reauthenticate."],
	["Google", "API key not valid. Please pass a valid API key."],
	[
		"Google",
		'400 {"error":{"code":400,"message":"API key expired. Please renew the API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
	],
	[
		"Google",
		"403 PERMISSION_DENIED: Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
	],
	["OpenRouter", '401 {"error":{"message":"No auth credentials found","code":401}}'],
	["OpenRouter", "No auth credentials found"],
	["OpenRouter", '401 {"error":{"message":"User not found.","code":401}}'],
	["Copilot", "GitHub Copilot authentication request failed (HTTP 401)"],
	["Copilot", "GitHub Copilot authentication request failed (HTTP 403)"],
	["Copilot", "401 unauthorized: token expired"],
	["DeepSeek", "401 Authentication Fails, Your api key: ****abcd is invalid"],
	// Credential providers' own text, which reaches the reply without an HTTP status.
	[
		"Bedrock",
		"The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
	],
	[
		"Bedrock",
		"The SSO session associated with this profile is invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
	],
	[
		"Bedrock",
		"The SSO session token associated with profile=dev was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
	],
	["Bedrock", "Unable to locate credentials"],
	["Bedrock", 'Unable to locate credentials. You can configure credentials by running "aws configure".'],
	[
		"Vertex",
		"Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.",
	],
	[
		"Vertex",
		"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
	],
	["Copilot", "Bad credentials"],
	["Copilot", '401 {"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}'],
	["ChatGPT", "Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT"],
	["ChatGPT", "The stored ChatGPT session has no verified account; sign in with ChatGPT again."],
	[
		"ChatGPT",
		"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
	],
	["OpenAI", "You didn't provide an API key. You need to provide your API key in an Authorization header"],
	[
		"Anthropic",
		'401 {"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"}}',
	],
	["Claude Code", "Not logged in · Please run /login"],
	["Google", "The API key you provided is not valid"],
	["Google", "Request had insufficient authentication scopes."],
	[
		"Bedrock",
		"InvalidSignatureException: The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.",
	],
	["DeepSeek", "Authentication Fails, Your api key: ****abcd is invalid"],
	["any", "Invalid authentication"],
	["any", "Authentication failed: invalid key"],
];

/** Failures that mention a status, an expiry or a token without being about the credential. */
const OTHER_FAILURES: [vendor: string, body: string][] = [
	["Anthropic", "prompt cache expired"],
	["Anthropic", '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
	["Anthropic", '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens is invalid"}}'],
	["OpenAI", "403 region not supported"],
	["OpenAI", "403 Country, region, or territory not supported"],
	["OpenAI", "429 You exceeded your current quota, please check your plan and billing details."],
	["Bedrock", 'AccessDeniedException: 403 {"message":"User is not authorized to perform bedrock:InvokeModel."}'],
	["Bedrock", 'AccessDeniedException: 403 {"message":"This model is not available for this account."}'],
	["Google", "429 RESOURCE_EXHAUSTED: Quota exceeded for metric: generate_content_free_tier_input_token_count"],
	["Google", "403 PERMISSION_DENIED: Permission denied on resource project my-project."],
	["OpenRouter", '403 {"error":{"message":"This model is not available in your region.","code":403}}'],
	["Copilot", '403 {"error":{"message":"The requested model is not supported."}}'],
	["any", "SyntaxError: Unexpected token < in JSON at position 0"],
	["any", "403 forbidden: 120000 input tokens per minute"],
	// "token" counts tokens here: only a named credential (an API key, an access or bearer token) can be missing.
	["any", "Missing token count in response"],
	["any", "Invalid tool call: missing token"],
];

describe("credential classification of real error bodies", () => {
	it.each(REFUSED_CREDENTIALS)("%s: counts %j as a refused credential", (_vendor, body) => {
		expect(isCredentialError(body)).toBe(true);
	});

	it.each(OTHER_FAILURES)("%s: does not count %j", (_vendor, body) => {
		expect(isCredentialError(body)).toBe(false);
	});
});
