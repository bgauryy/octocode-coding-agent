import { describe, expect, it } from "vitest";
import { assertBundleFresh } from "./bundle-freshness.ts";

describe("bundle freshness guard", () => {
	it("passes when the check passes", () => {
		expect(() => assertBundleFresh(() => ({ status: 0, stderr: "" }))).not.toThrow();
	});
	it("fails loudly, naming the fix, when the check fails", () => {
		expect(() => assertBundleFresh(() => ({ status: 1, stderr: "Workspace state bundle is stale." }))).toThrow(
			/stale.*generate:workspace/s,
		);
	});
	it("holds for the real bundle", () => {
		expect(() => assertBundleFresh()).not.toThrow();
	});
});
