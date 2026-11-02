import { createEventBus } from "@octocodeai/octocode-agent-core";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { octocodePrompt } from "../../src/octocode/instructions/policy.ts";
import { childSkills, registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
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
	it("leaves research to the server's own text: no server, tool or routing line, and no native fallback", () => {
		for (const canDelegate of [true, false]) {
			const prompt = octocodePrompt({ octocode: true, profiles: [], canDelegate });
			expect(prompt).not.toMatch(/mcp__octocode|mcp__browser|Octocode MCP|<mcps>/);
			expect(prompt).not.toContain("`await tools.mcp__octocode__<tool>(args)`");
			expect(prompt).not.toContain("Search with bash");
			expect(prompt).not.toContain("no lookup tool is available");
			for (const name of ["localSearch", "localFetch", "ghSearchCode", "lspSearch", "structureSearch"])
				expect(prompt).not.toContain(name);
		}
	});

	it("names the native research fallbacks only without the research server", () => {
		const fallback = octocodePrompt({ octocode: false, profiles: [], canDelegate: true });
		expect(fallback).toContain("Search with bash (`rg`, `fd`)");
		expect(fallback).not.toMatch(/mcp__octocode|mcp__browser|Octocode MCP/);
	});

	it("omits the codemode route when every Octocode tool is declared", () => {
		expect(octocodePrompt({ octocode: true, profiles: [], canDelegate: true })).not.toContain("tools.mcp__octocode__");
	});

	it("gives the parent delegation guidance and leaves skill loading to the skills section", () => {
		const root = octocodePrompt({ octocode: true, profiles: [], canDelegate: true });
		expect(root).toContain("give coupled work one owner");
		expect(root).toContain("verify reports against acceptance checks");
		// The agent tool's `skills` parameter says how to select skills; the policy does not repeat it.
		expect(root).not.toContain("input.skills");
		const child = octocodePrompt({ octocode: true, profiles: [], canDelegate: false });
		// The skills section (`core/skills.ts`) says when to load a skill; the policy does not restate it.
		for (const prompt of [root, child]) expect(prompt).not.toMatch(/load (that|a|the|any named) skill|skill first/i);
		expect(child).not.toContain("contract.md");
	});

	it("shows the base bash search rule only while no Octocode search tool is declared", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file", "mcp"]) fake.tools.set(name, { name, exposure: "direct" });
		fake.api.events = createEventBus();
		setMcpSessionStatus(fake.api.events, [
			{ name: "octocode", enabled: true, state: "connecting", toolCount: 0, source: "mcp.json", exposure: "direct" },
		]);
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const build = async (selectedTools: string[]) => {
			const event = {
				systemPromptOptions: { sections: {} as Record<string, string>, baseSections: {}, selectedTools },
			};
			await fake.emit("before_agent_start", event, {});
			return buildSystemPrompt({ cwd: "/tmp", selectedTools, contextFiles: [], sections: allSections(event) });
		};
		// Connecting: no Octocode search tool is declared yet, so the base rule stands; the policy says nothing about the server.
		const connecting = await build(["bash", "file", "mcp"]);
		expect(connecting).toContain("Use bash for file operations");
		expect(connecting).not.toContain("Search with bash");
		expect(connecting).not.toContain("Use Octocode MCP");
		// Declared: the tools carry their own descriptions, so the prompt gives no rule about code search at all.
		const declared = await build(["bash", "file", "mcp", "mcp__octocode__localSearch"]);
		expect(declared).not.toContain("Use bash for file operations");
		expect(declared).not.toContain("Search with bash");
		expect(declared).not.toContain("Use Octocode MCP");
		// A server that failed later keeps the same bytes (its state is in the `mcp_status` section); only a server that is not
		// enabled also gets the native research fallback.
		setMcpSessionStatus(fake.api.events, [
			{ name: "octocode", enabled: true, state: "failed", toolCount: 0, source: "mcp.json", exposure: "direct" },
		]);
		const failed = await build(["bash", "file", "mcp"]);
		expect(failed).toBe(connecting);
		setMcpSessionStatus(fake.api.events, [
			{ name: "octocode", enabled: false, state: "disabled", toolCount: 0, source: "mcp.json", exposure: "direct" },
		]);
		const disabled = await build(["bash", "file", "mcp"]);
		expect(disabled).toContain("Search with bash (`rg`, `fd`)");
		expect(disabled).toContain("Use bash for file operations like ls, rg, find");
	});
});

describe("registerTurnSetup routing and child trim", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	const run = async (
		fake: ReturnType<typeof fakeHost>,
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
		const fake = fakeHost();
		for (const name of ["bash", "file"]) fake.tools.set(name, { name, exposure: "direct" });
		fake.tools.set("mcp__octocode__ghSearchCode", {
			name: "mcp__octocode__ghSearchCode",
			exposure: "direct",
			namespace: { name: "mcp__octocode", instructions: "Search first, then fetch." },
		});

		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash", "file", "mcp__octocode__ghSearchCode"] });
		expect(sections.octocode).not.toContain("Search with bash");
		expect(sections.octocode_research).not.toMatch(/mcp__octocode|mcp__browser|Octocode MCP/);
		expect(sections.octocode).not.toContain("`await tools.mcp__octocode__<tool>(args)`");
		expect(sections.octocode).not.toContain("Search first, then fetch.");
		expect(sections.docs).toBeUndefined();
	});

	it("keeps Octocode guidance while a configured, enabled server is still connecting", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file", "mcp"]) fake.tools.set(name, { name, exposure: "direct" });

		fake.api.events = createEventBus();
		setMcpSessionStatus(fake.api.events, [
			{ name: "octocode", enabled: true, state: "connecting", toolCount: 0, source: "mcp.json", exposure: "direct" },
		]);
		registerTurnSetup(fake.api, { isSubagent: true, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash", "file", "mcp"] });
		expect(sections.octocode).not.toContain("Search with bash");
		const disabled = fakeHost();
		for (const name of ["bash", "file", "mcp"]) disabled.tools.set(name, { name, exposure: "direct" });
		registerTurnSetup(disabled.api, {
			isSubagent: true,
			profiles: () => new Map(),
		});
		expect((await run(disabled, { selectedTools: ["bash", "file", "mcp"] })).octocode).toContain("Search with bash");
	});

	it("falls back to shell research guidance when no Octocode tool or mcp is selected", async () => {
		const fake = fakeHost();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });
		fake.tools.set("mcp__octocode__ghSearchCode", {
			name: "mcp__octocode__ghSearchCode",
			exposure: "direct",
			defaultActive: false,
		});

		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash"] });
		expect(sections.octocode).toContain("Search with bash");
	});

	it("rebuilds lookup guidance when tools change without recommending unavailable tools", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "web", "agent"]) fake.tools.set(name, { name, exposure: "direct" });
		registerTurnSetup(fake.api, {
			isSubagent: false,
			profiles: () => new Map(),
		});
		const full = await run(fake, { selectedTools: ["bash", "web", "agent"] });
		expect(full.octocode).toContain("Use `web`");
		// The `<tools>` line of `agent` owns how to reach external agents; the policy does not repeat it.
		expect(full.octocode).not.toContain("`agent` type `external`");
		const shell = await run(fake, { selectedTools: ["bash"] });
		expect(shell.octocode).toContain("Use the `gh` CLI in bash when available");
		expect(shell.octocode).not.toMatch(/`web`|`agent`|agents-communication tools/);
		const bare = await run(fake, { selectedTools: [] });
		expect(bare.octocode).toContain("report the missing evidence");
		expect(bare.octocode).not.toMatch(/`web`|`agent`|bash|agents-communication tools/);
		expect((await run(fake, { selectedTools: ["bash", "web", "agent"] })).octocode).toBe(full.octocode);
	});

	it("does not restate the server's tool routing", async () => {
		const fake = fakeHost();
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const { octocode } = await run(fake, { selectedTools: ["mcp__octocode__lspSearch"] });
		expect(octocode).not.toContain("lspSearch");
	});

	it("keeps every policy section's bytes when the research server fails or stops after connecting", async () => {
		const natives = ["bash", "file", "mcp"];
		const status = (state: string) => [
			{ name: "octocode", enabled: true, state, toolCount: 0, source: "default", exposure: "direct" as const },
		];
		const fake = fakeHost();
		for (const name of natives) fake.tools.set(name, { name, exposure: "direct" });
		fake.api.events = createEventBus();
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		setMcpSessionStatus(fake.api.events, status("connected"));
		const before = await run(fake, { selectedTools: natives });
		for (const state of ["failed", "stopped"]) {
			setMcpSessionStatus(fake.api.events, status(state));
			const after = await run(fake, { selectedTools: natives });
			for (const name of Object.keys(before).filter((key) => key.startsWith("octocode")))
				expect(after[name]).toBe(before[name]);
		}
	});

	it("keeps bounded evidence and authorization guidance in root and child context", async () => {
		for (const isSubagent of [false, true]) {
			const fake = fakeHost();
			fake.tools.set("mcp__octocode__localFetch", { name: "mcp__octocode__localFetch", exposure: "direct" });
			registerTurnSetup(fake.api, {
				isSubagent,
				profiles: () => new Map(),
			});
			const { octocode } = await run(fake, { selectedTools: ["mcp__octocode__localFetch"] });
			expect(octocode).toContain("A permission refusal is not a reason to retry through another tool");
			expect(octocode).toContain("exact recovery identifiers");
			expect(octocode).toContain("state truncation or coverage gaps");
			expect(octocode).toContain("Fetch only the evidence the next decision needs");
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
			const fake = fakeHost();
			for (const name of [...natives, ...octocodeTools, ...browserTools])
				fake.tools.set(name, { name, exposure: "direct" });
			fake.api.events = createEventBus();
			registerTurnSetup(fake.api, {
				isSubagent,
				profiles: () =>
					new Map([["browser", { name: "browser", description: "Drives Chrome", tools: "mcp__browser__*" } as never]]),
			});
			setMcpSessionStatus(fake.api.events, status("connecting", 0));
			const before = await run(fake, { selectedTools: natives });
			setMcpSessionStatus(fake.api.events, status("connected", 4));
			const after = await run(fake, { selectedTools: [...natives, ...octocodeTools, ...browserTools] });
			// Every named section the prompt carries keeps its exact bytes, so the cached prefix survives the connection.
			expect(before.octocode_research).not.toMatch(/mcp__octocode|mcp__browser|Search with bash/);
			expect(after.octocode_research).toBe(before.octocode_research);
			expect(after.octocode_delegation).toBe(before.octocode_delegation);
			expect(after.octocode_work).toBe(before.octocode_work);
		}
	});

	it("delegates browser work to a specialist when the browser server is off or not selected, whatever the connection state", async () => {
		const fake = fakeHost();
		fake.api.events = createEventBus();
		const profiles = new Map([
			["browser", { name: "browser", description: "Drives Chrome", tools: "mcp__browser__*" } as never],
		]);
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => profiles });
		const selectedTools = ["bash", "agent", "mcp"];
		setMcpSessionStatus(fake.api.events, [
			{ name: "browser", enabled: false, state: "disabled", toolCount: 0, source: "default", exposure: "direct" },
		]);
		expect((await run(fake, { selectedTools })).octocode_delegation).toContain(
			"Delegate browser interaction to `browser`",
		);
		// The default: the browser server is enabled but only the browser subagent selects it.
		setMcpSessionStatus(fake.api.events, [
			{ name: "browser", enabled: true, state: "unselected", toolCount: 0, source: "default", exposure: "direct" },
		]);
		expect((await run(fake, { selectedTools })).octocode_delegation).toContain(
			"Delegate browser interaction to `browser`, which has the browser tools you lack",
		);
		setMcpSessionStatus(fake.api.events, [
			{ name: "browser", enabled: true, state: "connecting", toolCount: 0, source: "default", exposure: "direct" },
		]);
		const connecting = (await run(fake, { selectedTools })).octocode_delegation;
		setMcpSessionStatus(fake.api.events, [
			{ name: "browser", enabled: true, state: "connected", toolCount: 2, source: "default", exposure: "direct" },
		]);
		expect(connecting).not.toContain("Delegate browser interaction");
		expect((await run(fake, { selectedTools })).octocode_delegation).toBe(connecting);
	});

	it("drops the docs block and skill descriptions in a child", async () => {
		const fake = fakeHost();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });

		registerTurnSetup(fake.api, { isSubagent: true, profiles: () => new Map() });
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
		expect(prompt).toContain("Load a skill's file when the task matches its description.");
		expect(prompt).not.toContain("Use Octocode localFetch");
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
