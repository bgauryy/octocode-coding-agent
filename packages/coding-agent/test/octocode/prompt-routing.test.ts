import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { octocodePrompt } from "../../src/octocode/instructions/policy.ts";
import { childSkills, registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeOctocode, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

const skill = (name: string, disableModelInvocation = false): Skill => ({
	name,
	description: `Instructions for ${name}.`,
	filePath: `/skills/${name}/SKILL.md`,
	baseDir: `/skills/${name}`,
	sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
	disableModelInvocation,
});

describe("Octocode research routing in the policy", () => {
	it("tells the agent how to call undeclared Octocode tools through native discovery, without naming server tools", () => {
		const prompt = octocodePrompt({ octocode: true, profiles: [], canDelegate: true });
		expect(prompt).toContain("Use Octocode MCP (`mcp__octocode__*`) to check code before you rely on it");
		expect(prompt).not.toContain("`await tools.mcp__octocode__<tool>(args)`");
		expect(prompt).toContain("instead of answering from memory or a generic web search");
		for (const name of ["localSearch", "ghSearchCode", "lspSearch", "structureSearch"])
			expect(prompt).not.toContain(name);
	});

	it("omits the codemode route when every Octocode tool is declared", () => {
		expect(octocodePrompt({ octocode: true, profiles: [], canDelegate: true })).not.toContain("tools.mcp__octocode__");
	});

	it("gives the parent delegation guidance and the child the skill rule", () => {
		const root = octocodePrompt({ octocode: true, profiles: [], canDelegate: true });
		expect(root).toContain("Keep sequential or coupled work in one agent");
		expect(root).toContain("`.octocode/<topic>/contract.md`");
		expect(root).toContain("verify reports against the Definition of Done");
		// The agent tool's `skills` parameter says how to select skills; the policy does not repeat it.
		expect(root).not.toContain("input.skills");
		const child = octocodePrompt({ octocode: true, profiles: [], canDelegate: false, canWrite: true });
		expect(child).toContain("first load any skill it names");
		expect(child).not.toContain("contract.md");
	});
});

describe("registerTurnSetup routing and child trim", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	const run = async (fake: ReturnType<typeof fakePi>, options: { selectedTools: string[]; skills?: Skill[] }) => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string>, ...options } };
		await fake.emit("before_agent_start", event, {});
		return event.systemPromptOptions.sections;
	};

	it("keeps Octocode guidance and server instructions when a user-owned server leaves its tools to discovery", async () => {
		const fake = fakePi();
		for (const name of ["bash", "file", "tool_search"]) fake.tools.set(name, { name, exposure: "direct" });
		fake.tools.set("mcp__octocode__ghSearchCode", {
			name: "mcp__octocode__ghSearchCode",
			exposure: "deferred",
			defaultActive: false,
			namespace: { name: "mcp__octocode", instructions: "Search first, then fetch." },
		});
		const { mcp } = fakeOctocode({ by: "user", enabled: true });
		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map(), octocode: mcp });
		const sections = await run(fake, { selectedTools: ["bash", "file", "tool_search"] });
		expect(sections.octocode).toContain("Use Octocode MCP");
		expect(sections.octocode).not.toContain("`await tools.mcp__octocode__<tool>(args)`");
		expect(sections.octocode).toContain("Search first, then fetch.");
		expect(sections.docs).toBeUndefined();
	});

	it("keeps Octocode guidance while a configured, enabled server is still connecting", async () => {
		const fake = fakePi();
		for (const name of ["bash", "file", "tool_search"]) fake.tools.set(name, { name, exposure: "direct" });
		const { mcp } = fakeOctocode({ by: "user", enabled: true });
		registerTurnSetup(fake.pi, { isSubagent: true, profiles: () => new Map(), octocode: mcp });
		const sections = await run(fake, { selectedTools: ["bash", "file", "tool_search"] });
		expect(sections.octocode).toContain("Use Octocode MCP");
		const disabled = fakePi();
		for (const name of ["bash", "file", "tool_search"]) disabled.tools.set(name, { name, exposure: "direct" });
		registerTurnSetup(disabled.pi, {
			isSubagent: true,
			profiles: () => new Map(),
			octocode: fakeOctocode({ by: "user", enabled: false }).mcp,
		});
		expect((await run(disabled, { selectedTools: ["bash", "file", "tool_search"] })).octocode).not.toContain(
			"Use Octocode MCP",
		);
	});

	it("falls back to shell research guidance when discovery is not active", async () => {
		const fake = fakePi();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });
		fake.tools.set("mcp__octocode__ghSearchCode", {
			name: "mcp__octocode__ghSearchCode",
			exposure: "deferred",
			defaultActive: false,
		});
		const { mcp } = fakeOctocode({ by: "user", enabled: true });
		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map(), octocode: mcp });
		const sections = await run(fake, { selectedTools: ["bash"] });
		expect(sections.octocode).not.toContain("Use Octocode MCP");
	});

	it("drops the docs block and skill descriptions in a child", async () => {
		const fake = fakePi();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });
		const { mcp } = fakeOctocode({ by: "off" });
		registerTurnSetup(fake.pi, { isSubagent: true, profiles: () => new Map(), octocode: mcp });
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				selectedTools: ["bash"],
				skills: [skill("research"), skill("hidden", true)],
			},
		};
		await fake.emit("before_agent_start", event, {});
		expect(event.systemPromptOptions.sections.docs).toBe("");
		expect(event.systemPromptOptions.skills.map((s) => [s.name, s.description, s.disableModelInvocation])).toEqual([
			["research", skill("research").description, false],
			["hidden", skill("hidden").description, true],
		]);
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["bash", "mcp__octocode__localFetch"],
			contextFiles: [],
			sections: event.systemPromptOptions.sections,
			skills: event.systemPromptOptions.skills,
		});
		expect(prompt).not.toContain("<docs>");
		expect(prompt).toContain("<name>research</name>");
		expect(prompt).toContain("<description>");
		expect(prompt).toContain(
			"Use Octocode localFetch (or localGetFileContent) to load a skill file when the task matches its description.",
		);
	});

	it("keeps descriptions and the original trigger in a parent's list", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [skill("research")],
		});
		expect(prompt).toContain("<description>Instructions for research");
		expect(prompt).toContain("when the task matches its description");
		expect(childSkills([skill("x")])[0].description).toBe(skill("x").description);
	});
});
