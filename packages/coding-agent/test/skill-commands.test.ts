import { describe, expect, it } from "vitest";
import { getSkillCommands } from "../src/core/skill-commands.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function skill(name: string, filePath = `/skills/${name}/SKILL.md`): Skill {
	return {
		name,
		filePath,
		description: name,
		baseDir: "/skills",
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "local",
			scope: "project",
			origin: "top-level",
			baseDir: "/skills",
		}),
	};
}

describe("skill command names", () => {
	it("uses direct names and preserves skill identity", () => {
		const source = skill("research");
		const [command] = getSkillCommands([source]);
		expect(command).toEqual({ skill: source, name: "research" });
		expect(command.skill.sourceInfo).toBe(source.sourceInfo);
	});

	it("reserves builtins, extension names, resolved invocations, and templates", () => {
		const commands = getSkillCommands(
			["model", "ext", "ext:2", "prompt"].map((name) => skill(name)),
			[{ name: "ext", invocationName: "ext:2" }, { name: "prompt" }],
		);
		expect(commands.map((command) => command.name)).toEqual([
			"skill:model",
			"skill:ext",
			"skill:ext:2",
			"skill:prompt",
		]);
	});

	it("gives duplicate skills distinct qualified commands", () => {
		const commands = getSkillCommands([skill("review", "/one/SKILL.md"), skill("review", "/two/SKILL.md")]);
		expect(commands.map((command) => command.name)).toEqual(["skill:review:1", "skill:review:2"]);
		expect(commands.map((command) => command.skill.filePath)).toEqual(["/one/SKILL.md", "/two/SKILL.md"]);
	});
});
