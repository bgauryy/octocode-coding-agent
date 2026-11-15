import { describe, expect, it } from "vitest";
import { READ_ONLY_ENV } from "../../../common/src/env.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

describe("read-only subagent roles", () => {
	it("marks the bundled reviewer and researcher read-only, and not the implementer", () => {
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		expect(profiles.get("reviewer")?.readOnly).toBe(true);
		expect(profiles.get("researcher")?.readOnly).toBe(true);
		expect(profiles.get("implementer")?.readOnly).toBeUndefined();
	});

	it("passes read-only to the child and never inherits it from the parent", () => {
		const reviewer = loadProfiles(tmp(), tmp(), false, {}).get("reviewer");
		expect(subagentProcessEnv(reviewer, {}, { id: "a" })[READ_ONLY_ENV]).toBe("1");
		const implementer = loadProfiles(tmp(), tmp(), false, {}).get("implementer");
		expect(subagentProcessEnv(implementer, { [READ_ONLY_ENV]: "1" }, { id: "b" })[READ_ONLY_ENV]).toBeUndefined();
	});
});
