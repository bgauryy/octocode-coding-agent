import { describe, expect, it } from "vitest";
import { parseProfile } from "../../src/octocode/subagents/profiles.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";

describe("mcpDefer profile key", () => {
	it("parses a role name or a list and hands it to the child's environment", () => {
		for (const value of ["readOnly", "[readOnly]"]) {
			const profile = parseProfile("impl", `---\nmcpDefer: ${value}\n---\nTask`);
			expect(profile.mcpDefer).toEqual(["readOnly"]);
			expect(subagentProcessEnv(profile, {}).OCTOCODE_MCP_DEFER_ROLES).toBe("readOnly");
		}
	});

	it("defers nothing by default or with none", () => {
		for (const front of ["", "mcpDefer: none\n"]) {
			const profile = parseProfile("impl", `---\n${front}---\nTask`);
			expect(profile.mcpDefer).toBeUndefined();
			expect(subagentProcessEnv(profile, {}).OCTOCODE_MCP_DEFER_ROLES).toBeUndefined();
		}
	});

	it("does not let a parent's value reach a child whose profile has none", () => {
		const env = subagentProcessEnv(parseProfile("impl", "---\n---\nTask"), { OCTOCODE_MCP_DEFER_ROLES: "readOnly" });
		expect(env.OCTOCODE_MCP_DEFER_ROLES).toBeUndefined();
	});

	it("refuses an unknown role", () => {
		expect(() => parseProfile("impl", "---\nmcpDefer: everything\n---\nTask")).toThrow(/unknown role everything/);
	});
});
