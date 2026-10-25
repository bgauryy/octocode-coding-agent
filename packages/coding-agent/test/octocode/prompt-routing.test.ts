import { createEventBus } from "../../src/core/event-bus.ts";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { octocodePrompt } from "../../src/octocode/instructions/policy.ts";
import { childSkills, registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakePi } from "./fake-pi.ts";
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
		expect(prompt).toContain("instead of answering from memory.");
		expect(prompt).not.toContain("generic web search");
		for (const name of ["localSearch", "ghSearchCode", "lspSearch", "structureSearch"])
			expect(prompt).not.toContain(name);
	});

	it("omits the codemode route when every Octocode tool is declared", () => {
		expect(octocodePrompt({ octocode: true, profiles: [], canDelegate: true })).not.toContain("tools.mcp__octocode__");
	});

	it("gives the parent delegation guidance, and every agent the one skill rule", () => {
		const root = octocodePrompt({ octocode: true, profiles: [], canDelegate: true });
		expect(root).toContain("Keep coupled work in one agent");
		expect(root).toContain("`.octocode/<topic>/contract.md`");
		expect(root).toContain("check reports against acceptance checks");
		// The agent tool's `skills` parameter says how to select skills; the policy does not repeat it.
		expect(root).not.toContain("input.skills");
		const child = octocodePrompt({ octocode: true, profiles: [], canDelegate: false, canWrite: true });
		const skillRule = "when a listed skill's description matches it or the task names one, load that skill first";
		expect(root).toContain(skillRule);
		expect(child).toContain(skillRule);
		expect(child).not.toContain("load any named skill first");
		expect(child).not.toContain("contract.md");
	});
});

describe("registerTurnSetup routing and child trim", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	const run = async (
		fake: ReturnType<typeof fakePi>,
		options: { selectedTools: string[]; skills?: Skill[] },
	): Promise<Record<string, string>> => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string>, ...options } };
		await fake.emit("before_agent_start", event, {});
		return {
			...event.systemPromptOptions.sections,
			octocode: Object.values(event.systemPromptOptions.sections).join("\n\n"),
		};
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

		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash", "file", "tool_search"] });
		expect(sections.octocode).toContain("Use Octocode MCP");
		expect(sections.octocode).not.toContain("`await tools.mcp__octocode__<tool>(args)`");
		expect(sections.octocode).not.toContain("Search first, then fetch.");
		expect(sections.docs).toBeUndefined();
	});

	it("keeps Octocode guidance while a configured, enabled server is still connecting", async () => {
		const fake = fakePi();
		for (const name of ["bash", "file", "tool_search"]) fake.tools.set(name, { name, exposure: "direct" });

		fake.pi.events = createEventBus();
		setMcpSessionStatus(fake.pi.events, [
			{ name: "octocode", enabled: true, state: "connecting", toolCount: 0, source: "mcp.json", exposure: "auto" },
		]);
		registerTurnSetup(fake.pi, { isSubagent: true, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash", "file", "tool_search"] });
		expect(sections.octocode).toContain("Use Octocode MCP");
		const disabled = fakePi();
		for (const name of ["bash", "file", "tool_search"]) disabled.tools.set(name, { name, exposure: "direct" });
		registerTurnSetup(disabled.pi, {
			isSubagent: true,
			profiles: () => new Map(),
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

		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash"] });
		expect(sections.octocode).not.toContain("Use Octocode MCP");
	});

	it("rebuilds lookup guidance when tools change without recommending unavailable tools", async () => {
		const fake = fakePi();
		for (const name of ["bash", "web", "agent"]) fake.tools.set(name, { name, exposure: "direct" });
		registerTurnSetup(fake.pi, {
			isSubagent: false,
			profiles: () => new Map(),
		});
		const full = await run(fake, { selectedTools: ["bash", "web", "agent"] });
		expect(full.octocode).toContain("Use `web`");
		expect(full.octocode).toContain("`agent` type `external`");
		const shell = await run(fake, { selectedTools: ["bash"] });
		expect(shell.octocode).toContain("Use the `gh` CLI in bash when available");
		expect(shell.octocode).not.toMatch(/`web`|`agent`|agents-communication tools/);
		const bare = await run(fake, { selectedTools: [] });
		expect(bare.octocode).toContain("report the missing evidence");
		expect(bare.octocode).not.toMatch(/`web`|`agent`|bash|agents-communication tools/);
		expect((await run(fake, { selectedTools: ["bash", "web", "agent"] })).octocode).toBe(full.octocode);
	});

	it("keeps bounded evidence and authorization guidance in root and child context", async () => {
		for (const isSubagent of [false, true]) {
			const fake = fakePi();
			fake.tools.set("mcp__octocode__localFetch", { name: "mcp__octocode__localFetch", exposure: "direct" });
			registerTurnSetup(fake.pi, {
				isSubagent,
				profiles: () => new Map(),
			});
			const { octocode } = await run(fake, { selectedTools: ["mcp__octocode__localFetch"] });
			expect(octocode).toContain("A permission refusal is not a reason to retry through another tool.");
			expect(octocode).toContain("exact recovery identifiers");
			expect(octocode).toContain("state truncation or coverage gaps");
			expect(octocode).toContain("cached input still fills the context window");
			expect(octocode).not.toContain("Use bash for builds");
			expect(octocode).not.toContain("`agent`");
			if (isSubagent) {
				expect(octocode).toContain("no messaging tool is active");
				expect(octocode).toContain("leave it blocked in your report");
			}
		}
	});

	it("drops the docs block and skill descriptions in a child", async () => {
		const fake = fakePi();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });

		registerTurnSetup(fake.pi, { isSubagent: true, profiles: () => new Map() });
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
		expect(prompt).toContain("Use Octocode localFetch to load a skill file when the task matches its description.");
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
