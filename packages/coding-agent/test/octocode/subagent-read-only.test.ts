import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_ONLY_ENV } from "../../../common/src/env.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { ROLE_PROMPT_FILE_ENV, writeRolePrompt } from "../../src/octocode/instructions/role.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp, allSections } from "./helpers.ts";

/**
 * A reviewer or researcher keeps `file` for its own reports, so tool availability cannot tell it is read-only: the
 * profile says so, the parent passes it to the child, and the child's policy investigates and reports instead of
 * telling it to change code.
 */
describe("read-only subagent roles", () => {
	afterEach(() => vi.unstubAllEnvs());

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

	it("gives a read-only child the investigate-and-report rule though it has the file tool", async () => {
		const policy = async (readOnly: boolean) => {
			vi.stubEnv(ROLE_PROMPT_FILE_ENV, writeRolePrompt("Review the diff.", tmp()));
			vi.stubEnv(READ_ONLY_ENV, readOnly ? "1" : "");
			const fake = fakeHost();
			registerTurnSetup(fake.api, {
				isSubagent: true,
				profiles: () => new Map(),
			});
			const event = {
				systemPromptOptions: {
					sections: {} as Record<string, string>,
					baseSections: {} as Record<string, string>,
					selectedTools: ["file", "agent", "archive", "bash"],
				},
			};
			await fake.emit("before_agent_start", event, {});
			return Object.values(allSections(event)).join("\n");
		};
		const reviewer = await policy(true);
		expect(reviewer).toContain("Investigate and report; do not modify repository source.");
		expect(reviewer).not.toContain("Make the smallest complete fix");
		expect(await policy(false)).toContain("Make the smallest complete fix");
	});

	it("does not infer a read-only role from a main session without file tools", async () => {
		for (const selectedTools of [["bash"], ["web"]]) {
			const fake = fakeHost();
			registerTurnSetup(fake.api, {
				isSubagent: false,
				profiles: () => new Map(),
			});
			const event = {
				systemPromptOptions: {
					sections: {} as Record<string, string>,
					baseSections: {} as Record<string, string>,
					selectedTools,
				},
			};
			await fake.emit("before_agent_start", event, {});
			const prompt = Object.values(allSections(event)).join("\n\n");
			expect(prompt).toContain("Make the smallest complete fix");
			expect(prompt).not.toContain("Investigate and report; do not modify repository source");
			expect(prompt).not.toContain("Run only read-only commands");
			if (selectedTools[0] === "web") expect(prompt).not.toContain("Search with bash");
		}
	});
});
