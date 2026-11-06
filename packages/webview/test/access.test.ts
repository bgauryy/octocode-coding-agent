import { describe, expect, it } from "vitest";
import { bearer, readLaunch } from "../src/access.ts";

describe("launch access", () => {
	it("attaches the token as the only authorization header", () => {
		expect(bearer("secret")).toEqual({ Authorization: "Bearer secret" });
	});
	it("opens the item a launch names, and keeps the view without one", () => {
		expect(readLaunch("#access=t&view=board&item=B12")?.hash).toBe("#B12");
		expect(readLaunch("#access=t&item=B12/edit")?.hash).toBe("#board");
		expect(readLaunch("#access=t&view=activity")?.hash).toBe("#activity");
	});
	it("leaves a hash without a launch token untouched", () => {
		expect(readLaunch("#board")).toBeNull();
	});
});
