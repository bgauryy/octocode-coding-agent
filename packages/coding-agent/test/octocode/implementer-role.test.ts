import { describe, expect, it } from "vitest";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

describe("the implementer role", () => {
	it("carries instructions that deliver what its description promises", () => {
		const profile = loadProfiles(tmp(), tmp(), false, {}).get("implementer")!;
		expect(profile.description).toMatch(/changed paths, checks/);
		expect(profile.prompt).toMatch(/changed paths/);
		expect(profile.prompt).toMatch(/check/);
		expect(profile.readOnly).toBeUndefined();
	});
});
