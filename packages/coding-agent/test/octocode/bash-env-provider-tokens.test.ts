import { afterEach, describe, expect, it, vi } from "vitest";
import { bashSessionEnv } from "../../src/core/tools/bash.ts";
import { getShellEnv, setShellKeepsProviderKeys } from "../../src/utils/shell.ts";

afterEach(() => {
	setShellKeepsProviderKeys(false);
	vi.unstubAllEnvs();
});

/** Provider secrets outside the API-key table: Amazon Bedrock's bearer token is a key a shell command must not inherit. */
describe("the bash environment's provider tokens", () => {
	it("leaves out AWS_BEARER_TOKEN_BEDROCK by default and keeps the user's own AWS credentials", () => {
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "fake-bedrock-token");
		vi.stubEnv("AWS_PROFILE", "dev");
		for (const env of [getShellEnv(), bashSessionEnv(undefined)]) {
			expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
			expect(env.AWS_PROFILE).toBe("dev");
		}
		expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe("fake-bedrock-token");
	});

	it("keeps it with bash.inheritProviderKeys", () => {
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "fake-bedrock-token");
		setShellKeepsProviderKeys(true);
		expect(getShellEnv().AWS_BEARER_TOKEN_BEDROCK).toBe("fake-bedrock-token");
	});

	// OpenAI requests send each `Name: value` line as a header, so the variable can carry a gateway's bearer token.
	it("leaves out OPENAI_CUSTOM_HEADERS by default and keeps it with bash.inheritProviderKeys", () => {
		vi.stubEnv("OPENAI_CUSTOM_HEADERS", "Authorization: Bearer fake-gateway-token");
		for (const env of [getShellEnv(), bashSessionEnv(undefined)]) expect(env.OPENAI_CUSTOM_HEADERS).toBeUndefined();
		setShellKeepsProviderKeys(true);
		expect(getShellEnv().OPENAI_CUSTOM_HEADERS).toBe("Authorization: Bearer fake-gateway-token");
	});
});
