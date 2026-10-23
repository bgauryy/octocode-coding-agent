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
	it("uses direct names with qualified aliases and preserves skill identity", () => {
		const source = skill("research");
		const [command] = getSkillCommands([source]);
		expect(command).toEqual({
			skill: source,
			name: "research",
			qualifiedName: "skill:research",
			aliases: ["skill:research"],
		});
		expect(command.skill.sourceInfo).toBe(source.sourceInfo);
	});

	it("reserves builtins, extension names, resolved invocations, aliases, and templates", () => {
		const commands = getSkillCommands(
			["model", "ext", "ext:2", "alias", "prompt"].map((name) => skill(name)),
			[{ name: "ext", invocationName: "ext:2", aliases: ["alias"] }, { name: "prompt" }],
		);
		expect(commands.map((command) => command.name)).toEqual([
			"skill:model",
			"skill:ext",
			"skill:ext:2",
			"skill:alias",
			"skill:prompt",
		]);
		expect(commands.every((command) => command.aliases.length === 0)).toBe(true);
	});

	it("gives duplicate skills distinct qualified commands", () => {
		const commands = getSkillCommands([skill("review", "/one/SKILL.md"), skill("review", "/two/SKILL.md")]);
		expect(commands.map((command) => command.name)).toEqual(["skill:review:1", "skill:review:2"]);
		expect(commands.map((command) => command.skill.filePath)).toEqual(["/one/SKILL.md", "/two/SKILL.md"]);
	});
	it("reserves original aliases after extension collision qualification", () => {
		const [command] = getSkillCommands(
			[skill("shared")],
			[
				{ name: "one", aliases: ["shared:1"] },
				{ name: "two", aliases: ["shared:2"] },
			],
		);
		expect(command.name).toBe("skill:shared");
	});
});
