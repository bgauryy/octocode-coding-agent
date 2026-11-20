import { describe, expect, it } from "vitest";
import { childInUseTools } from "../../src/octocode/subagents/core-tools.ts";
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

	it("defers the read-only tools of a child started without a role", () => {
		expect(subagentProcessEnv(undefined, {}).OCTOCODE_MCP_DEFER_ROLES).toBe("readOnly");
		// A role decides for itself, `none` included: the general default never reaches it.
		expect(
			subagentProcessEnv(parseProfile("r", "---\nmcpDefer: none\n---\nTask"), {}).OCTOCODE_MCP_DEFER_ROLES,
		).toBeUndefined();
	});
});

describe("the in-use set a child takes from its coordinator", () => {
	const parent = [
		"octocode/localFetch",
		"octocode/ghSearchCode",
		"native/web",
		"native/wait",
		"native/memory",
		"native/archive",
		"native/models",
		"native/backlogPlan",
	];

	it("keeps what the shared tool prefix declares and drops the role-dependent native tools", () => {
		expect(childInUseTools(parent)).toEqual([
			"octocode/localFetch",
			"octocode/ghSearchCode",
			"native/web",
			"native/wait",
		]);
	});

	it("reaches the child as the set it declares by", () => {
		const env = subagentProcessEnv(undefined, {}, { id: "c", mcpRecent: childInUseTools(parent) });
		const handed = JSON.parse(env.OCTOCODE_MCP_RECENT_TOOLS ?? "[]") as string[];
		expect(handed).toContain("native/wait");
		expect(handed).not.toContain("native/memory");
		expect(handed).not.toContain("native/backlogPlan");
	});
});

describe("a role's skill catalog in the child's environment", () => {
	it("hands an empty catalog on as an empty value, and an absent one not at all", () => {
		const empty = parseProfile("b", "---\ncatalog: []\n---\nTask");
		expect(empty.catalog).toEqual([]);
		expect(subagentProcessEnv(empty, {}).OCTOCODE_SKILL_CATALOG).toBe("");
		expect(subagentProcessEnv(parseProfile("b", "---\n---\nTask"), {}).OCTOCODE_SKILL_CATALOG).toBeUndefined();
		expect(subagentProcessEnv(undefined, {}).OCTOCODE_SKILL_CATALOG).toContain("octocode-research");
	});
});
