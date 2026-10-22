import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.OCTOCODE_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.OCTOCODE_EXPERIMENTAL;
		} else {
			process.env.OCTOCODE_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when OCTOCODE_EXPERIMENTAL is unset", () => {
		delete process.env.OCTOCODE_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when OCTOCODE_EXPERIMENTAL is empty", () => {
		process.env.OCTOCODE_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when OCTOCODE_EXPERIMENTAL is set to 1", () => {
		process.env.OCTOCODE_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when OCTOCODE_EXPERIMENTAL is set to 0", () => {
		process.env.OCTOCODE_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when OCTOCODE_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.OCTOCODE_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
