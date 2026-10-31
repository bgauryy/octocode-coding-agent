import { describe, expect, it } from "vitest";
import { bearer, readLaunch } from "../src/access.ts";

describe("launch access", () => {
	it("attaches the token as the only authorization header", () => {
		expect(bearer("secret")).toEqual({ Authorization: "Bearer secret" });
	});
	it("leaves a hash without a launch token untouched", () => {
		expect(readLaunch("#board")).toBeNull();
	});
});
