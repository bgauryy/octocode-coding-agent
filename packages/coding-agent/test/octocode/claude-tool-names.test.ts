import { afterEach, describe, expect, it } from "vitest";
import { toolAliases } from "../../src/octocode/hooks/config/calls.ts";
import { names } from "../../src/octocode/permission/source-policy/rules.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", platform));

/** The names each surface gives an Octocode tool: hooks match `tool` plus these; permission rules use these. */
const HOOK_NAMES: Record<string, string[]> = {
	bash: ["Bash"],
	read: ["Read"],
	edit: ["Edit"],
	write: ["Write"],
	file: ["Edit", "Write", "MultiEdit"],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["LS"],
	web: ["WebFetch", "WebSearch"],
	agent: ["Task"],
};
const RULE_NAMES: Record<string, string[]> = {
	bash: ["Bash"],
	powershell: ["PowerShell"],
	read: ["Read"],
	edit: ["Edit"],
	write: ["Write"],
	file: ["Write", "Edit", "Delete"],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["LS"],
	web: ["WebFetch", "WebSearch"],
	agent: ["Agent", "agent.message", "agent.coordinate"],
};

describe("Claude Code tool names", () => {
	it("hooks match the Octocode name plus Claude Code's names, with MultiEdit and Task as hook-only extras", () => {
		for (const [tool, claude] of Object.entries(HOOK_NAMES)) expect(toolAliases(tool)).toEqual([tool, ...claude]);
		expect(toolAliases("mcp__x__y")).toEqual(["mcp__x__y"]);
	});

	it("permission rules name tools with Delete, PowerShell on Windows and the agent.* operations as rule-only extras", () => {
		for (const [tool, claude] of Object.entries(RULE_NAMES)) expect(names(tool)).toEqual(claude);
		expect(names("mcp__x__y")).toEqual(["mcp__x__y"]);
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(names("bash")).toEqual(["Bash", "PowerShell"]);
	});

	it("agree on the base names", () => {
		for (const tool of ["read", "edit", "write", "grep", "find", "ls", "web"])
			expect(names(tool)).toEqual(HOOK_NAMES[tool]);
	});
});
