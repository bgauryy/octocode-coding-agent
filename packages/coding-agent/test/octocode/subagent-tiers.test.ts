import fs from "node:fs";
import os from "node:os";
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
import { prefixKey, taskSkillPlan, taskSkillText, withRoleSkills } from "../../src/octocode/subagents/task-skills.ts";
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
	it("run their own tools plus bash, agent and timer by default, without the specialist floor", () => {
		const lean = parseProfile("lean", "---\nlean: true\n---\nDo the task.");
		expect(lean).toMatchObject({ lean: true, tools: "bash,agent,file,timer" });
		expect(profileTools(lean)).toBe("bash,agent,file,timer");
		expect(profileReach(lean)).toEqual(["file.workspace", "shell"]);
		const cli = parseProfile("cli", "---\nlean: true\ntools: bash\n---\n");
		expect(profileTools(cli)).toBe("bash,agent,timer");
		// A list that omits the floor gets it; one that names it is not repeated; archive and MCP never join.
		expect(profileTools(parseProfile("r", "---\nlean: true\ntools: read\n---\n"))).toBe("read,bash,agent,timer");
		expect(profileTools(parseProfile("s", "---\nlean: true\ntools: steps,bash,agent\n---\n"))).toBe(
			"steps,bash,agent,timer",
		);
		expect(profileReach(cli)).toEqual(["shell"]);
	});

	it("refuse relative tool selectors, which would inherit the full default set", () => {
		expect(() => parseProfile("bad", "---\nlean: true\ntools: +bash\n---\n")).toThrow(/lean.*explicit tool list/);
	});

	it("start without MCP or extensions and mark the child lean", () => {
		const lean = parseProfile("lean", "---\nlean: true\n---\n");
		const args = buildAgentArgs(lean, undefined, session, []);
		expect(args).toEqual(expect.arrayContaining(["--no-mcp", "--tools", "bash,agent,file,timer"]));
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
		expect(Object.keys(event.systemPromptOptions.sections)).toContain("lean");
		expect(text).toContain("You are a subagent: do exactly the task, then stop.");
		expect(text).not.toContain("Start it with the outcome word");
		expect(text).not.toContain("## Understand the request");
		expect(text).not.toContain("Octocode MCP");
		expect(event.systemPromptOptions.skills).toEqual([]);
		// The `octocode` CLI documents itself (2026-11-05), so the lean section never names it.
		expect(text).not.toContain("`octocode");
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
		// A role's skills never narrow the catalog: the child inherits it and its role section holds the role's skills.
		expect(taskSkillPlan(specialist, undefined)).toEqual({ inTask: false, inline: false, roleSkills: ["alpha"] });
		expect(taskSkillPlan(specialist, ["beta"])).toEqual({ names: ["beta"], inTask: true, inline: false });
		expect(taskSkillPlan(lean, undefined)).toEqual({ names: [], inTask: true, inline: true });
		expect(taskSkillPlan(lean, ["alpha"])).toEqual({ names: ["alpha"], inTask: true, inline: true });
	});

	it("inline a role's skills in its role prompt, the same for every sibling, while it keeps the whole catalog", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-skills-"));
		try {
			const skillFile = (name: string, body: string) => {
				const file = path.join(dir, name, "SKILL.md");
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
				return file;
			};
			const skills = [
				{ name: "alpha", filePath: skillFile("alpha", "Alpha body"), disableModelInvocation: false },
				{ name: "beta", filePath: skillFile("beta", "Beta body"), disableModelInvocation: false },
				{ name: "hidden", filePath: skillFile("hidden", "Hidden body"), disableModelInvocation: true },
			].map((skill) => ({
				...skill,
				description: `${skill.name} skill`,
				baseDir: path.dirname(skill.filePath),
				sourceInfo: { path: skill.filePath, source: "user", scope: "user", origin: "top-level" },
			}));
			const snapshot = captureSkillResourceSnapshot(
				{ skills, diagnostics: [] } as unknown as Parameters<typeof captureSkillResourceSnapshot>[0],
				undefined,
				[],
			);
			const role = parseProfile("two", "---\nskills: [beta, alpha, hidden, missing]\n---\nRole body");
			const plan = taskSkillPlan(role, undefined);
			// No `names`: the child inherits the catalog instead of a narrowed list.
			expect(plan.names).toBeUndefined();
			expect(plan.inTask).toBe(false);
			const prompt = withRoleSkills(role, plan.roleSkills, snapshot).prompt;
			expect(prompt.startsWith("Role body\n\n# Your role's skills\n")).toBe(true);
			expect(prompt.indexOf("Beta body")).toBeGreaterThan(-1);
			expect(prompt.indexOf("Beta body")).toBeLessThan(prompt.indexOf("Alpha body"));
			expect(prompt).not.toContain("Hidden body");
			expect(prompt).not.toContain("missing");
			expect(withRoleSkills(role, plan.roleSkills, snapshot).prompt).toBe(prompt);
			// Nothing to inline: the profile itself, untouched.
			expect(withRoleSkills(role, undefined, snapshot)).toBe(role);
			expect(withRoleSkills(role, [], snapshot)).toBe(role);
			expect(withRoleSkills(undefined, ["alpha"], snapshot)).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("inline a role skill whole, however long it is", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-role-skill-"));
		try {
			const filePath = path.join(dir, "SKILL.md");
			const body = `${"x".repeat(128 * 1024)}LAST_LINE`;
			fs.writeFileSync(filePath, `---\nname: long\ndescription: long skill\n---\n${body}\n`);
			const skill = {
				name: "long",
				filePath,
				disableModelInvocation: false,
				description: "long skill",
				baseDir: dir,
				sourceInfo: { path: filePath, source: "user", scope: "user", origin: "top-level" },
			};
			const snapshot = captureSkillResourceSnapshot(
				{ skills: [skill], diagnostics: [] } as unknown as Parameters<typeof captureSkillResourceSnapshot>[0],
				undefined,
				[],
			);
			const prompt = withRoleSkills(
				parseProfile("one", "---\nskills: [long]\n---\nRole body"),
				["long"],
				snapshot,
			).prompt;
			expect(prompt).toContain(body);
			expect(prompt).not.toContain("[Cut at");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
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
			inTask: false,
			inline: false,
			roleSkills: ["alpha"],
		});
		expect(taskSkillPlan(specialist, undefined, [prompt])).toEqual({ inTask: false, inline: false });
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
		expect(Object.keys(event.systemPromptOptions.sections)).toContain("work");

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
