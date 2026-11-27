import { describe, expect, it } from "vitest";
import { parseOAuthTokenResponse } from "../src/auth/oauth/token-response.ts";

describe("OAuth token response validation", () => {
	it.each([
		null,
		[],
		{},
		{ access_token: 42, refresh_token: "secret", expires_in: 60 },
		{ access_token: "secret", refresh_token: {}, expires_in: 60 },
		{ access_token: "secret", refresh_token: "secret", expires_in: -1 },
		{ access_token: "secret", refresh_token: "secret", expires_in: Number.POSITIVE_INFINITY },
	])("rejects malformed responses without leaking secrets", (value) => {
		expect(() => parseOAuthTokenResponse(value, "Provider")).toThrow(/OAuth response/);
		try {
			parseOAuthTokenResponse(value, "Provider");
		} catch (error) {
			expect(String(error)).not.toContain("secret");
		}
	});
	it("retains unrotated refresh tokens and bounds the expiry margin", () => {
		const before = Date.now();
		const result = parseOAuthTokenResponse({ access_token: "access", expires_in: 30 }, "Provider", {
			previousRefresh: "refresh",
			expiryMarginMs: 300_000,
		});
		expect(result.refresh).toBe("refresh");
		expect(result.expires).toBeGreaterThanOrEqual(before + 27_000);
	});
});
