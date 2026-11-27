import { describe, expect, it } from "vitest";
import { describeSource, redactUrl } from "../../src/octocode/plugins/marketplace/source.ts";

describe("marketplace redactUrl", () => {
	it("shows user info as ***@ and removes secret query parameters", () => {
		expect(redactUrl("https://user:pw@example.com/repo.git")).toBe("https://***@example.com/repo.git");
		expect(redactUrl("https://example.com/repo.git?token=abc&ref=main")).toBe(
			"https://example.com/repo.git?token=redacted&ref=main",
		);
		expect(redactUrl("https://tok@example.com/r.git?api_key=k")).toBe("https://***@example.com/r.git?api_key=redacted");
	});

	it("leaves a URL without credentials and text that is no URL as it is, masking user info in the text", () => {
		expect(redactUrl("https://example.com/repo.git")).toBe("https://example.com/repo.git");
		expect(redactUrl("git@example.com:org/repo.git")).toBe("git@example.com:org/repo.git");
		expect(redactUrl("//user:pw@")).toBe("//***@");
	});

	it("keeps secrets out of the one-line description of a git source", () => {
		expect(describeSource({ source: "git", url: "https://u:p@example.com/r.git?access_token=s", ref: "v1" })).toBe(
			"git https://***@example.com/r.git?access_token=redacted#v1",
		);
	});
});
