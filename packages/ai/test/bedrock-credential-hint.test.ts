import { describe, expect, it } from "vitest";
import { bedrockErrorHint } from "../src/api/bedrock-converse-stream/errors.ts";

describe("bedrockErrorHint credentials", () => {
	it.each([
		"Your session has expired. Please reauthenticate.",
		"Token is expired",
		"Could not load credentials from any providers",
		"ExpiredTokenException: The security token included in the request is expired",
		"UnrecognizedClientException: The security token included in the request is invalid.",
	])("leaves the fix for %j to the host, naming no terminal command", (message) => {
		// coding-agent knows how Bedrock signs in, so it alone says `aws sso login` (credential-error-context.ts).
		expect(bedrockErrorHint(message)).toBe("");
	});

	it("still points a model access error at the model card", () => {
		const hint = bedrockErrorHint("The provided model identifier is invalid.");
		expect(hint).toContain("Bedrock model card");
		expect(hint).not.toContain("sso");
	});
});
