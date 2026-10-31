import { describe, expect, it } from "vitest";
import { parseWwwAuthenticate } from "../../src/client/oauth/discovery.ts";

describe("parseWwwAuthenticate", () => {
	it("reads quoted and bare parameters", () => {
		expect(
			parseWwwAuthenticate(
				'Bearer resource_metadata="https://rs.example/meta", scope="org:read org:write", error=invalid_token',
			),
		).toEqual({
			resourceMetadataUrl: new URL("https://rs.example/meta"),
			scope: "org:read org:write",
			error: "invalid_token",
			errorDescription: undefined,
		});
	});

	// The SDK's pattern would return the two quote characters, which then became the requested scope.
	it("treats an empty quoted value as absent", () => {
		const challenge = parseWwwAuthenticate('Bearer scope="", error="", error_description=""');
		expect(challenge.scope).toBeUndefined();
		expect(challenge.error).toBeUndefined();
		expect(challenge.errorDescription).toBeUndefined();
	});

	it("ignores a missing or unrecognized challenge", () => {
		expect(parseWwwAuthenticate(null)).toEqual({});
		expect(parseWwwAuthenticate('Basic realm="x"')).toEqual({});
	});
});
