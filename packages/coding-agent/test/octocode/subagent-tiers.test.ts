import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandInfo } from "../../src/core/slash-commands.ts";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { loadProfiles, parseProfile, profileReach, profileTools } from "../../src/octocode/subagents/profiles.ts";
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
	it("run their own tools plus bash and agent by default, without timer or the specialist floor", () => {
		const lean = parseProfile("lean", "---\nlean: true\n---\nDo the task.");
		expect(lean).toMatchObject({ lean: true, tools: "bash,agent,file" });
		expect(profileTools(lean)).toBe("bash,agent,file");
		expect(profileReach(lean)).toEqual(["file.workspace", "shell"]);
		const cli = parseProfile("cli", "---\nlean: true\ntools: bash\n---\n");
		expect(profileTools(cli)).toBe("bash,agent");
		// A list that omits the floor gets it; one that names it is not repeated; archive and MCP never join.
		expect(profileTools(parseProfile("r", "---\nlean: true\ntools: read\n---\n"))).toBe("read,bash,agent");
		expect(profileTools(parseProfile("s", "---\nlean: true\ntools: steps,bash,agent\n---\n"))).toBe("steps,bash,agent");
		// `timer` is not in the floor: a lean profile has it only when its list names it.
		expect(profileTools(parseProfile("t", "---\nlean: true\ntools: bash,timer\n---\n"))).toBe("bash,timer,agent");
		expect(profileReach(cli)).toEqual(["shell"]);
	});

	it("ship the bundled lean role with bash, file, web and the parent channel only", () => {
		const lean = loadProfiles(tmp(), tmp(), false, {}).get("lean")!;
		expect(profileTools(lean).split(",").sort()).toEqual(["agent", "bash", "file", "web"]);
		expect(buildAgentArgs(lean, undefined, session, [])).toContain("--no-mcp");
	});

	it("refuse relative tool selectors, which would inherit the full default set", () => {
		expect(() => parseProfile("bad", "---\nlean: true\ntools: +bash\n---\n")).toThrow(/lean.*explicit tool list/);
	});

	it("start without MCP or extensions and mark the child lean", () => {
		const lean = parseProfile("lean", "---\nlean: true\n---\n");
		const args = buildAgentArgs(lean, undefined, session, []);
		expect(args).toEqual(expect.arrayContaining(["--no-mcp", "--tools", "bash,agent,file"]));
		expect(args).not.toContain("builtin:mcp");
		expect(args).not.toContain("--no-extensions");
		expect(buildAgentArgs(undefined, undefined, session, [])).not.toContain("--no-mcp");
		expect(subagentProcessEnv(lean, { PATH: "/bin" }, { id: "c" })).toMatchObject({
			OCTOCODE_LEAN: "1",
			OCTOCODE_MEMORY_AUTO: "0",
		});
		const specialist = subagentProcessEnv(undefined, { OCTOCODE_LEAN: "1" }, { id: "c" });
		expect(specialist.OCTOCODE_LEAN).toBeUndefined();
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
				contextFiles: [],
				cwd: "/repo",
			},
		};
		await fake.emit("before_agent_start", event, {});
		const text = Object.values(allSections(event)).join("\n");
		expect(Object.keys(event.systemPromptOptions.sections)).toContain("lean");
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

	it("ride in the task whenever they are chosen, and inherit the parent's skill list otherwise", () => {
		expect(taskSkillPlan(undefined, undefined)).toEqual({ inline: false });
		expect(taskSkillPlan(undefined, [])).toEqual({ names: [], inline: false });
		expect(taskSkillPlan(undefined, ["beta"])).toEqual({ names: ["beta"], inline: false });
		// A role's skills never narrow the list: the child inherits it and its role section holds the role's skills.
		expect(taskSkillPlan(specialist, undefined)).toEqual({ inline: false, roleSkills: ["alpha"] });
		expect(taskSkillPlan(specialist, ["beta"])).toEqual({ names: ["beta"], inline: false });
		expect(taskSkillPlan(lean, undefined)).toEqual({ names: [], inline: true });
		expect(taskSkillPlan(lean, ["alpha"])).toEqual({ names: ["alpha"], inline: true });
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
			// No `names`: the child inherits the parent's skill list instead of a narrowed one.
			expect(plan.names).toBeUndefined();
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
		expect(taskSkillPlan(specialist, undefined, [skill("alpha")])).toEqual({ inline: false, roleSkills: ["alpha"] });
		expect(taskSkillPlan(specialist, undefined, [prompt])).toEqual({ inline: false });
		expect(taskSkillPlan(specialist, ["beta"], [])).toEqual({ names: ["beta"], inline: false });
	});

	it("name the skills a task asks for and leave the list to the skill tool", () => {
		const skill = (name: string) =>
			({ name, source: "skill", sourceInfo: { path: `/s/${name}/SKILL.md` } }) as unknown as SlashCommandInfo;
		const commands = [skill("alpha"), skill("beta")];
		// No named skills: the child inherits the parent's list, whatever its role names.
		expect(taskSkillPlan(specialist, undefined, commands)).toEqual({ inline: false, roleSkills: ["alpha"] });
		expect(taskSkillPlan(specialist, ["beta"], commands)).toEqual({ names: ["beta"], inline: false });
		// The text for the named skills says which to load first, not the whole list.
		const loaded = skills();
		const real = loaded.skills.map(
			(s) => ({ name: s.name, source: "skill", sourceInfo: s.sourceInfo }) as unknown as SlashCommandInfo,
		);
		const text = taskSkillText(captureSkillResourceSnapshot(loaded, ["alpha"], real), false);
		expect(text).toContain("alpha");
		expect(text).not.toContain("beta");
		expect(text).not.toContain("<available_skills>");
	});

	it("are named for the skill tool to load first, or inlined whole for a lean child", () => {
		const snapshot = captureSkillResourceSnapshot(skills());
		const listed = taskSkillText(snapshot, false);
		expect(listed).toContain("Load these skills with the `skill` tool");
		expect(listed).toContain("alpha");
		expect(listed).not.toContain("BODY_alpha");
		const inlined = taskSkillText(snapshot, true);
		expect(inlined).toMatch(/<skill name="alpha" location="[^"]+SKILL\.md">/);
		expect(inlined).toContain("BODY_beta");
		expect(inlined).not.toContain("description: Use for");
		expect(taskSkillText({ version: 1, resources: [], explicitSkills: [] }, false)).toBe("");
	});

	it("leave siblings of one profile and model on one cache prefix whatever skills they get", () => {
		expect(prefixKey("researcher", "m")).toBe(prefixKey("researcher", "m", {}));
		expect(prefixKey("researcher", "m")).not.toBe(prefixKey("coder", "m"));
	});

	it("keep the child's system prompt free of skills", async () => {
		const fake = fakeHost();
		registerTurnSetup(fake.api, { isSubagent: true, profiles: () => new Map() });
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools: ["bash", "file", "skill"],
				contextFiles: [],
				cwd: "/repo",
			},
		};
		await fake.emit("before_agent_start", event, {});
		expect(Object.keys(event.systemPromptOptions.sections)).toContain("work");
		expect(event.systemPromptOptions).not.toHaveProperty("skills");
	});
});
