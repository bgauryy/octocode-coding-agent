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
import { FAKE_RESEARCH } from "./fake-research.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";

// Whether the research CLI resolves depends on the host; these tests choose it.
const cli = vi.hoisted(() => ({ available: false }));
vi.mock("../../src/octocode/cli/shim.ts", async (original) => ({
	...(await original<object>()),
	octocodeCliAvailable: () => cli.available,
}));
afterEach(() => {
	cli.available = false;
});

useResearchRoles();

const skill = (name: string, disableModelInvocation = false): Skill => ({
	name,
	description: `Instructions for ${name}.`,
	filePath: `/skills/${name}/SKILL.md`,
	baseDir: `/skills/${name}`,
	sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
	disableModelInvocation,
});

describe("research routing in the policy", () => {
	it("routes research to the research server by its roles and leaves out the bash search fallback", () => {
		for (const canDelegate of [true, false]) {
			const prompt = octocodePrompt({ research: FAKE_RESEARCH, profiles: [], canDelegate });
			expect(prompt).toContain("use the research tools (`mcp__research__*`): search with");
			expect(prompt).toContain("search with `search_code` and read source");
			expect(prompt).not.toMatch(/mcp__browser/);
			expect(prompt).not.toContain("Search with bash");
			expect(prompt).not.toContain("no lookup tool is available");
			// Tools without a reader or search role are the server's own text to name.
			for (const name of ["list_files", "fetch_remote"]) expect(prompt).not.toContain(name);
		}
	});

	it("joins several search tools in the order the entry lists them", () => {
		const research = { ...FAKE_RESEARCH, search: ["mcp__research__a", "mcp__research__b", "mcp__research__c"] };
		expect(octocodePrompt({ research, profiles: [], canDelegate: true })).toContain("search with `a`, `b` or `c` and");
	});

	it("names the native research fallbacks only without the research server", () => {
		const fallback = octocodePrompt({ research: undefined, profiles: [], canDelegate: true });
		expect(fallback).toContain("Search with bash when the location is unknown");
		expect(fallback).not.toMatch(/mcp__research|mcp__browser|research tools/);
	});

	it("gives the parent delegation guidance and leaves skill loading to the skills section", () => {
		const root = octocodePrompt({ research: FAKE_RESEARCH, profiles: [], canDelegate: true });
		expect(root).toContain("one owner per coupled part or shared resource");
		expect(root).toContain(
			"A report is a claim: read `Noticed` first; verify what the next step depends on against the diff, tests or state.",
		);
		// The agent tool's `skills` parameter says how to select skills; the policy does not repeat it.
		expect(root).not.toContain("input.skills");
		const child = octocodePrompt({ research: FAKE_RESEARCH, profiles: [], canDelegate: false });
		// The skills section (`core/skills.ts`) says when to load a skill; the policy does not restate it.
		for (const prompt of [root, child]) expect(prompt).not.toMatch(/load (that|a|the|any named) skill|skill first/i);
		expect(child).not.toContain("contract.md");
	});

	it("shows the base bash search rule only while no search-role tool is declared", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file", "mcp"]) fake.tools.set(name, { name, exposure: "direct" });
		fake.api.events = createEventBus();
		setMcpSessionStatus(fake.api.events, [
			{
				name: RESEARCH.server,
				enabled: true,
				state: "connecting",
				toolCount: 0,
				source: "mcp.json",
				exposure: "direct",
			},
		]);
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const build = async (selectedTools: string[]) => {
			const event = {
				systemPromptOptions: { sections: {} as Record<string, string>, baseSections: {}, selectedTools },
			};
			await fake.emit("before_agent_start", event, {});
			return buildSystemPrompt({ cwd: "/tmp", selectedTools, contextFiles: [], sections: allSections(event) });
		};
		// Connecting: the research section already routes to the research server, so the base bash search rule is left out.
		const connecting = await build(["bash", "file", "mcp"]);
		expect(connecting).not.toContain("Search and read files with bash");
		expect(connecting).not.toContain("Search with bash");
		expect(connecting).toContain("use the research tools (`mcp__research__*`)");
		// Declared: the same routing, still no bash search rule.
		const declared = await build(["bash", "file", "mcp", RESEARCH.search]);
		expect(declared).not.toContain("Search and read files with bash");
		expect(declared).not.toContain("Search with bash");
		expect(declared).toContain("use the research tools (`mcp__research__*`)");
		// A server that failed later keeps the same bytes (its state is in the `mcp_status` section); only a server that is not
		// enabled gets the native research fallback.
		setMcpSessionStatus(fake.api.events, [
			{ name: RESEARCH.server, enabled: true, state: "failed", toolCount: 0, source: "mcp.json", exposure: "direct" },
		]);
		const failed = await build(["bash", "file", "mcp"]);
		expect(failed).toBe(connecting);
		setMcpSessionStatus(fake.api.events, [
			{
				name: RESEARCH.server,
				enabled: false,
				state: "disabled",
				toolCount: 0,
				source: "mcp.json",
				exposure: "direct",
			},
		]);
		const disabled = await build(["bash", "file", "mcp"]);
		expect(disabled).toContain("Search with bash when the location is unknown");
		expect(disabled).toContain("Search and read files with bash (rg, fd, ls, sed -n)");
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

	it("keeps research guidance without restating server instructions when a research server tool is declared", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file"]) fake.tools.set(name, { name, exposure: "direct" });
		fake.tools.set(RESEARCH.other, {
			name: RESEARCH.other,
			exposure: "direct",
			namespace: { name: "mcp__research", instructions: "Search first, then fetch." },
		});

		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const sections = await run(fake, { selectedTools: ["bash", "file", RESEARCH.other] });
		expect(sections.octocode).not.toContain("Search with bash");
		expect(sections.research).toContain("use the research tools (`mcp__research__*`)");
		expect(sections.research).not.toMatch(/mcp__browser/);
		expect(sections.octocode).not.toContain("`await tools.mcp__octocode__<tool>(args)`");
		expect(sections.octocode).not.toContain("Search first, then fetch.");
		expect(sections.docs).toBeUndefined();
	});

	it("keeps research guidance while a configured, enabled server is still connecting", async () => {
		const fake = fakeHost();
		for (const name of ["bash", "file", "mcp"]) fake.tools.set(name, { name, exposure: "direct" });

		fake.api.events = createEventBus();
		setMcpSessionStatus(fake.api.events, [
			{
				name: RESEARCH.server,
				enabled: true,
				state: "connecting",
				toolCount: 0,
				source: "mcp.json",
				exposure: "direct",
			},
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

	it("never explains the octocode CLI, even when agent shells have it", async () => {
		cli.available = true;
		const fake = fakeHost();
		for (const name of ["bash", "file", RESEARCH.other]) fake.tools.set(name, { name, exposure: "direct" });
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const withServer = await run(fake, { selectedTools: ["bash", "file", RESEARCH.other] });
		expect(withServer.research).toContain("say so and restart its server; if it still fails, fall back to bash search");
		const bashOnly = await run(fake, { selectedTools: ["bash"] });
		expect(bashOnly.research).toContain("Search with bash");
		for (const sections of [withServer, bashOnly])
			for (const text of Object.values(sections)) expect(text).not.toMatch(/`octocode[` ]/);
	});

	it("falls back to shell research guidance when no research server tool or mcp is selected", async () => {
		const fake = fakeHost();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });
		fake.tools.set(RESEARCH.other, {
			name: RESEARCH.other,
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
		const { octocode } = await run(fake, { selectedTools: [RESEARCH.readOnly] });
		expect(octocode).not.toContain("list_files");
	});

	it("keeps every policy section's bytes when the research server fails or stops after connecting", async () => {
		const natives = ["bash", "file", "mcp"];
		const status = (state: string) => [
			{ name: RESEARCH.server, enabled: true, state, toolCount: 0, source: "default", exposure: "direct" as const },
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
			fake.tools.set(RESEARCH.reader, { name: RESEARCH.reader, exposure: "direct" });
			registerTurnSetup(fake.api, {
				isSubagent,
				profiles: () => new Map(),
			});
			const { octocode } = await run(fake, { selectedTools: [RESEARCH.reader] });
			expect(octocode).toContain(
				"Never bypass a hook, a safety check (such as `--no-verify`) or a permission refusal, for example by retrying through another tool",
			);
			expect(octocode).toContain("exact paths, item/agent/job/message ids and cursors");
			expect(octocode).toContain("state truncation or coverage gaps");
			expect(octocode).toContain("Fetch only the evidence the next decision needs");
			expect(octocode).not.toContain("Use bash for builds");
			expect(octocode).not.toContain("`agent`");
			if (isSubagent) {
				expect(octocode).toContain("have no messaging tool");
				expect(octocode).toContain("leave it blocked in your report");
			}
		}
	});

	it("keeps the research and delegation sections byte-identical before and after the MCP servers connect", async () => {
		const natives = ["bash", "file", "agent", "mcp"];
		const octocodeTools = [RESEARCH.search, RESEARCH.reader, RESEARCH.readOnly, RESEARCH.other];
		const browserTools = ["open", "run"].map((n) => `mcp__browser__${n}`);
		const status = (state: string, toolCount: number) => [
			{ name: RESEARCH.server, enabled: true, state, toolCount, source: "default", exposure: "direct" as const },
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
			expect(before.research).toContain("use the research tools (`mcp__research__*`)");
			expect(before.research).not.toMatch(/mcp__browser|Search with bash/);
			expect(after.research).toBe(before.research);
			expect(after.delegation).toBe(before.delegation);
			expect(after.work).toBe(before.work);
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
		expect((await run(fake, { selectedTools })).delegation).toContain("Delegate browser interaction to `browser`");
		// The default: the browser server is enabled but only the browser subagent selects it.
		setMcpSessionStatus(fake.api.events, [
			{ name: "browser", enabled: true, state: "unselected", toolCount: 0, source: "default", exposure: "direct" },
		]);
		expect((await run(fake, { selectedTools })).delegation).toContain(
			"Delegate browser interaction to `browser`: give the task, URL and required evidence. Follow up the same agent while reachable; it has the browser tools you lack.",
		);
		setMcpSessionStatus(fake.api.events, [
			{ name: "browser", enabled: true, state: "connecting", toolCount: 0, source: "default", exposure: "direct" },
		]);
		const connecting = (await run(fake, { selectedTools })).delegation;
		setMcpSessionStatus(fake.api.events, [
			{ name: "browser", enabled: true, state: "connected", toolCount: 2, source: "default", exposure: "direct" },
		]);
		expect(connecting).not.toContain("Delegate browser interaction");
		expect((await run(fake, { selectedTools })).delegation).toBe(connecting);
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
			selectedTools: ["bash", RESEARCH.reader],
			contextFiles: [],
			sections: allSections(event),
			skills: event.systemPromptOptions.skills,
		});
		expect(prompt).not.toContain("<docs>");
		// An indirect reader loads the file, so the entry carries its path beside the description.
		expect(prompt).toMatch(/<skill name="research" location="[^"]+">[^<]+<\/skill>/);
		expect(prompt).toContain(
			"Load the file of every skill whose description matches the task before other work; several can apply.",
		);
		expect(prompt).not.toContain("Use Octocode localFetch");
	});

	it("keeps descriptions and the original trigger in a parent's list", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [skill("research")],
		});
		expect(prompt).toMatch(/<skill name="research"[^>]*>Instructions for research/);
		expect(prompt).toContain("whose description matches the task");
		expect(childSkills([skill("x")])[0].description).toBe(skill("x").description);
	});
});
