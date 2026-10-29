import { createEventBus } from "../../src/core/event-bus.ts";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { octocodePrompt } from "../../src/octocode/instructions/policy.ts";
import { childSkills, registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakePi } from "./fake-pi.ts";
import { tmp, allSections } from "./helpers.ts";

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
		expect(prompt).toContain("(instead of answering from memory)");
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
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				...options,
			},
		};
		await fake.emit("before_agent_start", event, {});
		return {
			...allSections(event),
			octocode: Object.values(allSections(event)).join("\n\n"),
		};
	};

	it("keeps Octocode guidance without restating server instructions when an Octocode tool is declared", async () => {
		const fake = fakePi();
		for (const name of ["bash", "file"]) fake.tools.set(name, { name, exposure: "direct" });
		fake.tools.set("mcp__octocode__ghSearchCode", {
			name: "mcp__octocode__ghSearchCode",
			exposure: "direct",
			namespace: { name: "mcp__octocode", instructions: "Search first, then fetch." },
		});

		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash", "file", "mcp__octocode__ghSearchCode"] });
		expect(sections.octocode).toContain("Use Octocode MCP");
		expect(sections.octocode).not.toContain("`await tools.mcp__octocode__<tool>(args)`");
		expect(sections.octocode).not.toContain("Search first, then fetch.");
		expect(sections.docs).toBeUndefined();
	});

	it("keeps Octocode guidance while a configured, enabled server is still connecting", async () => {
		const fake = fakePi();
		for (const name of ["bash", "file", "mcp"]) fake.tools.set(name, { name, exposure: "direct" });

		fake.pi.events = createEventBus();
		setMcpSessionStatus(fake.pi.events, [
			{ name: "octocode", enabled: true, state: "connecting", toolCount: 0, source: "mcp.json", exposure: "direct" },
		]);
		registerTurnSetup(fake.pi, { isSubagent: true, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash", "file", "mcp"] });
		expect(sections.octocode).toContain("Use Octocode MCP");
		const disabled = fakePi();
		for (const name of ["bash", "file", "mcp"]) disabled.tools.set(name, { name, exposure: "direct" });
		registerTurnSetup(disabled.pi, {
			isSubagent: true,
			profiles: () => new Map(),
		});
		expect((await run(disabled, { selectedTools: ["bash", "file", "mcp"] })).octocode).not.toContain(
			"Use Octocode MCP",
		);
	});

	it("falls back to shell research guidance when no Octocode tool or mcp is selected", async () => {
		const fake = fakePi();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });
		fake.tools.set("mcp__octocode__ghSearchCode", {
			name: "mcp__octocode__ghSearchCode",
			exposure: "direct",
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

	it("routes native graph questions without MCP and updates the cached prompt with tool selection", async () => {
		const fake = fakePi();
		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map() });
		const selectedTools = ["graphBuild", "graphQuery"];
		const full = (await run(fake, { selectedTools })).octocode;
		expect(full).toContain("Repeated repository or package dependency, cycle and broad impact questions");
		expect(full).toContain("`graphQuery`");
		expect(full).toContain("`graphBuild` when writes are permitted");
		expect(full).not.toContain("Use Octocode MCP");
		const query = (await run(fake, { selectedTools: ["graphQuery"] })).octocode;
		expect(query).toContain("`graphQuery` on an existing snapshot");
		expect(query).not.toContain("graphBuild");
		expect((await run(fake, { selectedTools: [] })).octocode).not.toMatch(/graphBuild|graphQuery/);
		expect((await run(fake, { selectedTools })).octocode).toBe(full);
	});

	it("routes graph questions without restating the server's tool routing", async () => {
		const fake = fakePi();
		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map() });
		const { octocode } = await run(fake, {
			selectedTools: ["graphBuild", "graphQuery", "mcp__octocode__lspSearch"],
		});
		expect(octocode).toContain("broad impact questions: `graphQuery`");
		expect(octocode).not.toContain("lspSearch");
	});

	it("lets a read-only child build a graph, saying it writes only derived snapshots", async () => {
		vi.stubEnv("OCTOCODE_READ_ONLY", "1");
		const fake = fakePi();
		registerTurnSetup(fake.pi, { isSubagent: true, profiles: () => new Map() });
		const { octocode } = await run(fake, { selectedTools: ["file", "graphBuild", "graphQuery"] });
		expect(octocode).toContain("`graphQuery` on an existing snapshot; create or refresh it with `graphBuild`");
		expect(octocode).toContain(".octocode/graph/");
		expect(octocode).not.toContain("when writes are permitted");
		// Without graphQuery the build line stands alone and says the same.
		const build = (await run(fake, { selectedTools: ["file", "graphBuild"] })).octocode;
		expect(build).toContain("`graphBuild`");
		expect(build).toContain(".octocode/graph/");
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

	it("keeps the research and delegation sections byte-identical before and after the MCP servers connect", async () => {
		const natives = ["bash", "file", "agent", "mcp"];
		const octocodeTools = ["localSearch", "localFetch", "ghSearchCode", "lspSearch"].map((n) => `mcp__octocode__${n}`);
		const browserTools = ["open", "run"].map((n) => `mcp__browser__${n}`);
		const status = (state: string, toolCount: number) => [
			{ name: "octocode", enabled: true, state, toolCount, source: "default", exposure: "direct" as const },
			{ name: "browser", enabled: true, state, toolCount, source: "default", exposure: "direct" as const },
		];
		for (const isSubagent of [false, true]) {
			const fake = fakePi();
			for (const name of [...natives, ...octocodeTools, ...browserTools])
				fake.tools.set(name, { name, exposure: "direct" });
			fake.pi.events = createEventBus();
			registerTurnSetup(fake.pi, {
				isSubagent,
				profiles: () =>
					new Map([["browser", { name: "browser", description: "Drives Chrome", tools: "+browser" } as never]]),
			});
			setMcpSessionStatus(fake.pi.events, status("connecting", 0));
			const before = await run(fake, { selectedTools: natives });
			setMcpSessionStatus(fake.pi.events, status("connected", 4));
			const after = await run(fake, { selectedTools: [...natives, ...octocodeTools, ...browserTools] });
			// Every named section the prompt carries keeps its exact bytes, so the cached prefix survives the connection.
			expect(before.octocode_research).toContain("Use Octocode MCP");
			expect(after.octocode_research).toBe(before.octocode_research);
			expect(after.octocode_delegation).toBe(before.octocode_delegation);
			expect(after.octocode_work).toBe(before.octocode_work);
		}
	});

	it("delegates browser work to a specialist when the browser server is off or not selected, whatever the connection state", async () => {
		const fake = fakePi();
		fake.pi.events = createEventBus();
		const profiles = new Map([
			["browser", { name: "browser", description: "Drives Chrome", tools: "+browser" } as never],
		]);
		registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => profiles });
		const selectedTools = ["bash", "agent", "mcp"];
		setMcpSessionStatus(fake.pi.events, [
			{ name: "browser", enabled: false, state: "disabled", toolCount: 0, source: "default", exposure: "direct" },
		]);
		expect((await run(fake, { selectedTools })).octocode_delegation).toContain(
			"Delegate browser interaction to `browser`",
		);
		// The default: the browser server is enabled but only the browser subagent selects it.
		setMcpSessionStatus(fake.pi.events, [
			{ name: "browser", enabled: true, state: "unselected", toolCount: 0, source: "default", exposure: "direct" },
		]);
		expect((await run(fake, { selectedTools })).octocode_delegation).toContain(
			"Delegate browser interaction to `browser`, which has the browser tools you lack",
		);
		setMcpSessionStatus(fake.pi.events, [
			{ name: "browser", enabled: true, state: "connecting", toolCount: 0, source: "default", exposure: "direct" },
		]);
		const connecting = (await run(fake, { selectedTools })).octocode_delegation;
		setMcpSessionStatus(fake.pi.events, [
			{ name: "browser", enabled: true, state: "connected", toolCount: 2, source: "default", exposure: "direct" },
		]);
		expect(connecting).not.toContain("Delegate browser interaction");
		expect((await run(fake, { selectedTools })).octocode_delegation).toBe(connecting);
	});

	it("drops the docs block and skill descriptions in a child", async () => {
		const fake = fakePi();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });

		registerTurnSetup(fake.pi, { isSubagent: true, profiles: () => new Map() });
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools: ["bash"],
				skills: [skill("research"), skill("hidden", true)],
			},
		};
		await fake.emit("before_agent_start", event, {});
		expect(allSections(event).docs).toBe("");
		expect(event.systemPromptOptions.skills.map((s) => [s.name, s.description, s.disableModelInvocation])).toEqual([
			["research", skill("research").description, false],
			["hidden", skill("hidden").description, true],
		]);
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["bash", "mcp__octocode__localFetch"],
			contextFiles: [],
			sections: allSections(event),
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
