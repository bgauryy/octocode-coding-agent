import { describe, expect, it } from "vitest";
import { skillLoads, skillOf } from "../src/matchers/skills.ts";
import { call, traceOf } from "./matchers-fixtures.ts";

describe("toHaveLoadedSkill", () => {
	it("recognizes a skill_load event", () => {
		expect(traceOf([{ kind: "skill_load", name: "runbook" }])).toHaveLoadedSkill("runbook");
	});

	it.each([
		["name", { name: "runbook" }],
		["skill", { skill: "runbook" }],
		["command", { command: "runbook" }],
		["command with slash", { command: "/runbook" }],
	])("recognizes a Skill tool call by args.%s", (_l, args) => {
		expect(traceOf([call("Skill", args)])).toHaveLoadedSkill("runbook");
		expect(traceOf([call("skill", args)])).toHaveLoadedSkill("runbook");
	});

	it("recognizes a Claude style Read of SKILL.md", () => {
		expect(traceOf([call("Read", { file_path: "/x/skills/runbook/SKILL.md" })])).toHaveLoadedSkill("runbook");
	});

	it("recognizes a Codex style shell command array", () => {
		expect(traceOf([call("shell", { command: ["cat", "/x/runbook/SKILL.md"] })])).toHaveLoadedSkill("runbook");
	});

	it("finds paths nested in objects and arrays and with backslashes", () => {
		expect(traceOf([call("any", { a: [{ b: "C:\\s\\runbook\\SKILL.md" }] })])).toHaveLoadedSkill("runbook");
	});

	it("does not match another skill, a prefix, or a non-skill Skill arg", () => {
		const t = traceOf([call("read", { path: "/s/test-runner/SKILL.md" }), call("Other", { skill: "runbook" })]);
		expect(() => expect(t).toHaveLoadedSkill("test")).toThrow(/expected skill test to load/);
		expect(() => expect(t).toHaveLoadedSkill("runbook")).toThrow(/expected skill runbook to load/);
	});

	it("escapes regex characters in the name", () => {
		expect(() => expect(traceOf([call("read", { path: "/s/axb/SKILL.md" })])).toHaveLoadedSkill("a.b")).toThrow(
			/to load/,
		);
	});

	const SKILL = "/x/skills/runbook/SKILL.md";
	it.each([
		["Claude Code Bash cat", call("Bash", { command: `cat ${SKILL}` })],
		["Codex sed -n", call("shell", { command: ["bash", "-lc", `sed -n '1,200p' ${SKILL}`] })],
		["shell head in a pipeline", call("exec_command", { cmd: `head -50 "${SKILL}" | grep -n step` })],
		["octocode-agent read", call("read", { path: SKILL })],
		["octocode-agent skill tool", call("skill", { name: "runbook" })],
		["a read_file tool", call("read_file", { target_file: SKILL })],
		["a text editor view", call("str_replace_based_edit_tool", { command: "view", path: SKILL })],
		["an MCP fetch", call("mcp__octocode__localFetch", { queries: [{ path: SKILL }] })],
		["a read that silences stderr", call("Bash", { command: `cat ${SKILL} 2>/dev/null` })],
	])("still counts a read: %s", (_label, ev) => {
		const t = traceOf([ev]);
		expect(t).toHaveLoadedSkill("runbook");
		expect(skillLoads(t)).toEqual(["runbook"]);
		expect(skillOf(t.events[0])).toBe("runbook");
	});

	it("skillLoads names exactly the skills toHaveLoadedSkill passes for", () => {
		const t = traceOf([
			call("Skill", { skill: "planner" }),
			call("Edit", { file_path: "/s/drafts/SKILL.md", old_string: "a", new_string: "b" }),
			call("Bash", { command: "cat /s/a/SKILL.md; rm /s/b/SKILL.md" }),
			{ kind: "skill_load", name: "pdf" },
		]);
		expect(skillLoads(t)).toEqual(["planner", "a", "pdf"]);
		for (const name of ["planner", "a", "pdf"]) expect(t).toHaveLoadedSkill(name);
		for (const name of ["drafts", "b"]) expect(() => expect(t).toHaveLoadedSkill(name)).toThrow(/to load/);
	});
});
