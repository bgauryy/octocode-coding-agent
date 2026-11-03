import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandInfo } from "../../src/core/slash-commands.ts";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { registerSkillTool } from "../../src/octocode/skill/tool.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { parseProfile, profileReach, profileTools } from "../../src/octocode/subagents/profiles.ts";
import { prefixKey, taskSkillPlan, taskSkillText } from "../../src/octocode/subagents/task-skills.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { allSections, tmp } from "./helpers.ts";

const session = { dir: "/tmp/session", id: "child" };

function skills() {
	const root = fs.realpathSync(tmp("tier-skills-"));
	for (const name of ["alpha", "beta"]) {
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Use for ${name} work.\n---\n# ${name}\n\nBODY_${name}\n`,
		);
	}
	return loadSkillsFromDir({ dir: root, source: "test" });
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("lean profiles", () => {
	it("run their own tools plus bash, agent and steps by default, without the specialist floor", () => {
		const lean = parseProfile("lean", "---\nlean: true\n---\nDo the task.");
		expect(lean).toMatchObject({ lean: true, tools: "bash,agent,steps,file" });
		expect(profileTools(lean)).toBe("bash,agent,steps,file");
		expect(profileReach(lean)).toEqual(["file.workspace", "shell"]);
		const cli = parseProfile("cli", "---\nlean: true\ntools: bash\n---\n");
		expect(profileTools(cli)).toBe("bash,agent,steps");
		// A list that omits the floor gets it; one that names it is not repeated; archive and MCP never join.
		expect(profileTools(parseProfile("r", "---\nlean: true\ntools: read\n---\n"))).toBe("read,bash,agent,steps");
		expect(profileTools(parseProfile("s", "---\nlean: true\ntools: steps,bash,agent\n---\n"))).toBe("steps,bash,agent");
		expect(profileReach(cli)).toEqual(["shell"]);
	});

	it("refuse relative tool selectors, which would inherit the full default set", () => {
		expect(() => parseProfile("bad", "---\nlean: true\ntools: +bash\n---\n")).toThrow(/lean.*explicit tool list/);
	});

	it("start without MCP or extensions and mark the child lean", () => {
		const lean = parseProfile("lean", "---\nlean: true\n---\n");
		const args = buildAgentArgs(lean, undefined, session, []);
		expect(args).toEqual(expect.arrayContaining(["--no-mcp", "--tools", "bash,agent,steps,file"]));
		expect(args).not.toContain("builtin:mcp");
		expect(args).not.toContain("--no-extensions");
		expect(buildAgentArgs(undefined, undefined, session, [])).not.toContain("--no-mcp");
		expect(subagentProcessEnv(lean, { PATH: "/bin" }, { id: "c" })).toMatchObject({
			OCTOCODE_LEAN: "1",
			OCTOCODE_MEMORY_AUTO: "0",
		});
		const specialist = subagentProcessEnv(undefined, { OCTOCODE_LEAN: "1", OCTOCODE_SKILLS_IN_TASK: "1" }, { id: "c" });
		expect(specialist.OCTOCODE_LEAN).toBeUndefined();
		expect(specialist.OCTOCODE_SKILLS_IN_TASK).toBeUndefined();
		expect(subagentProcessEnv(undefined, {}, { id: "c", skillsInTask: true }).OCTOCODE_SKILLS_IN_TASK).toBe("1");
	});

	it("get a short subagent prompt instead of the full policy; the report contract rides in the task", async () => {
		vi.stubEnv("OCTOCODE_LEAN", "1");
		const fake = fakeHost();
		registerTurnSetup(fake.api, { isSubagent: true, profiles: () => new Map() });
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools: ["bash", "file"],
				skills: skills(),
				contextFiles: [],
				cwd: "/repo",
			},
		};
		await fake.emit("before_agent_start", event, {});
		const text = Object.values(allSections(event)).join("\n");
		expect(Object.keys(event.systemPromptOptions.sections)).toContain("octocode_lean");
		expect(text).toContain("You are a subagent: do exactly the task, then stop.");
		expect(text).not.toContain("Start it with the outcome word");
		expect(text).not.toContain("# Work and verification");
		expect(text).not.toContain("Octocode MCP");
		expect(event.systemPromptOptions.skills).toEqual([]);
		expect(text.length).toBeLessThan(1500);
	});
});

describe("profile skills", () => {
	it("reads a comma list or a YAML list", () => {
		expect(parseProfile("a", "---\nskills: alpha, beta\n---\n").skills).toEqual(["alpha", "beta"]);
		expect(parseProfile("b", "---\nskills:\n  - alpha\n---\n").skills).toEqual(["alpha"]);
		expect(() => parseProfile("c", "---\nskills: 3\n---\n")).toThrow(/skills/);
	});
});

describe("per-task skills", () => {
	const specialist = parseProfile("researcher", "---\nskills: alpha\n---\n");
	const lean = parseProfile("lean", "---\nlean: true\n---\n");

	it("ride in the task whenever they are chosen, and inherit the catalog in the prompt otherwise", () => {
		expect(taskSkillPlan(undefined, undefined)).toEqual({ inTask: false, inline: false });
		expect(taskSkillPlan(undefined, [])).toEqual({ names: [], inTask: true, inline: false });
		expect(taskSkillPlan(undefined, ["beta"])).toEqual({ names: ["beta"], inTask: true, inline: false });
		expect(taskSkillPlan(specialist, undefined)).toEqual({ names: ["alpha"], inTask: true, inline: false });
		expect(taskSkillPlan(specialist, ["beta"])).toEqual({ names: ["beta"], inTask: true, inline: false });
		expect(taskSkillPlan(lean, undefined)).toEqual({ names: [], inTask: true, inline: true });
		expect(taskSkillPlan(lean, ["alpha"])).toEqual({ names: ["alpha"], inTask: true, inline: true });
	});

	it("leave out a role skill the session cannot load, but pass the task's own names through", () => {
		const skill = (name: string) =>
			({ name, source: "skill", sourceInfo: { path: `/s/${name}/SKILL.md` } }) as unknown as SlashCommandInfo;
		const prompt = {
			name: "alpha",
			source: "prompt",
			sourceInfo: { path: "/p/alpha.md" },
		} as unknown as SlashCommandInfo;
		expect(taskSkillPlan(specialist, undefined, [skill("alpha")])).toEqual({
			names: ["alpha"],
			inTask: true,
			inline: false,
		});
		expect(taskSkillPlan(specialist, undefined, [prompt])).toEqual({ names: [], inTask: true, inline: false });
		expect(taskSkillPlan(specialist, ["beta"], [])).toEqual({ names: ["beta"], inTask: true, inline: false });
	});

	it("are listed for the skill tool, or inlined whole for a lean child", () => {
		const snapshot = captureSkillResourceSnapshot(skills());
		const listed = taskSkillText(snapshot, false);
		expect(listed).toContain("<available_skills>");
		expect(listed).toContain("alpha");
		expect(listed).not.toContain("BODY_alpha");
		const inlined = taskSkillText(snapshot, true);
		expect(inlined).toMatch(/<skill name="alpha" location="[^"]+SKILL\.md">/);
		expect(inlined).toContain("BODY_beta");
		expect(inlined).not.toContain("description: Use for");
		expect(taskSkillText({ version: 1, resources: [], explicitSkills: [] }, false)).toBe("");
	});

	it("leave siblings of one profile and model on one cache prefix whatever skills they get", () => {
		expect(prefixKey("researcher", "m", { names: ["a"], inTask: true, inline: false })).toBe(
			prefixKey("researcher", "m", { names: ["b"], inTask: true, inline: false }),
		);
		expect(prefixKey("researcher", "m", { inTask: false, inline: false })).not.toBe(
			prefixKey("researcher", "m", { names: [], inTask: true, inline: false }),
		);
	});

	it("drop the prompt's skills section in the child and keep the skill tool declared without skills", async () => {
		vi.stubEnv("OCTOCODE_SKILLS_IN_TASK", "1");
		const fake = fakeHost();
		registerTurnSetup(fake.api, { isSubagent: true, profiles: () => new Map() });
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools: ["bash", "file", "skill"],
				skills: skills(),
				contextFiles: [],
				cwd: "/repo",
			},
		};
		await fake.emit("before_agent_start", event, {});
		expect(event.systemPromptOptions.skills).toEqual([]);
		expect(Object.keys(event.systemPromptOptions.sections)).toContain("octocode_work");

		const skillHost = fakeHost();
		(skillHost.api as unknown as { getSkillResourceSnapshot: () => unknown }).getSkillResourceSnapshot = () => ({
			version: 1,
			resources: [],
			explicitSkills: [],
		});
		registerSkillTool(withNativePermissionOwners(skillHost.api));
		expect(skillHost.tools.get("skill").prepareLoadout({})).toBeUndefined();
	});
});
