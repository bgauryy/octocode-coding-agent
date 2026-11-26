import fs from "node:fs";
import { ROLE_PROMPT_FILE_ENV, writeRolePrompt } from "../../src/octocode/native/prompts/role.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../../src/core/system-prompt.ts";
import type { SkillCatalog } from "../../src/octocode/skill/catalog.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { BROWSER_SERVER } from "@octocodeai/octocode-common/mcp-names";
import { tmp, allSections } from "./helpers.ts";

describe("registerTurnSetup", () => {
	// The research server is the one whose entry gives reader and search roles (`mcp/src/roles.ts`), never a name.
	useResearchRoles();
	const setup = () => {
		const fake = fakeHost();
		for (const name of ["read", "bash", "file"]) fake.tools.set(name, { name });
		const turn = registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		turns.set(fake, turn);
		return { fake, turn };
	};
	const turns = new Map<ReturnType<typeof fakeHost>, ReturnType<typeof registerTurnSetup>>();
	const setupTurn = (fake: ReturnType<typeof fakeHost>) => turns.get(fake)!;
	const run = async (fake: ReturnType<typeof fakeHost>, selectedTools?: string[]) => {
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				...(selectedTools ? { selectedTools } : {}),
			},
		};
		await fake.emit("before_agent_start", event, {});
		return Object.values(allSections(event)).join("\n\n");
	};
	const argv = process.argv;
	let agentDir = "";
	// Octocode's own mcp.json (in the agent directory) can replace the registration: keep the developer's out of the tests.
	beforeEach(() => {
		agentDir = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	});
	afterEach(() => {
		process.argv = argv;
		vi.unstubAllEnvs();
	});

	it("uses the core tool set at session start and leaves the active set alone per turn", async () => {
		const { fake } = setup();
		process.argv = ["node", "octocode"];
		expect(fake.api.tools.getActive()).toEqual(["read", "bash", "file"]);
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools: ["read", "edit"],
			},
		};
		await fake.emit("before_agent_start", event, {});
		expect(event.systemPromptOptions.selectedTools).toEqual(["read", "edit"]);
	});

	it("keeps custom tools across reload and resume without name-based pruning", async () => {
		const { fake } = setup();
		process.argv = ["node", "octocode"];
		await fake.emit("session_start", { type: "session_start", reason: "startup" }, {});
		expect(fake.api.tools.getActive()).toEqual(["read", "bash", "file"]);
		fake.api.tools.setActive(["read", "bash", "edit", "write", "file"]);
		await fake.emit("session_start", { type: "session_start", reason: "reload" }, {});
		expect(fake.api.tools.getActive()).toEqual(["read", "bash", "edit", "write", "file"]);
		// Custom tools remain registered even if they use former built-in names.
		await fake.emit("session_start", { type: "session_start", reason: "resume" }, {});
		expect(fake.api.tools.getActive()).toEqual(["read", "bash", "edit", "write", "file"]);
	});

	it("keeps edit/write explicitly selected by the session", async () => {
		const { fake } = setup();
		fake.api.tools.setActive(["read", "bash", "edit", "write", "file"]);
		process.argv = ["node", "octocode", "--tools", "read,edit,write,file"];
		await run(fake);
		expect(fake.api.tools.getActive()).toEqual(["read", "bash", "edit", "write", "file"]);
	});

	it.each(["edit", "+edit"])("does not synthesize a removed tool from the %s setting", async (entry) => {
		const { fake } = setup();
		vi.spyOn(fake.api.settings, "get").mockReturnValue({ defaultTools: [entry, "-write"] });
		await run(fake);
		expect(fake.api.tools.getActive()).toEqual(["read", "bash", "file"]);
	});

	it("does not inherit another session's tool choices from the host command line", async () => {
		const { fake } = setup();
		process.argv = ["node", "host", "--tools", "read,edit,write,file"];
		await run(fake);
		expect(fake.api.tools.getActive()).toEqual(["read", "bash", "file"]);
	});

	it.each([false, true])("preserves browser and web selections for isSubagent=%s", async (isSubagent) => {
		const fake = fakeHost();
		const selected = ["read", "file", "mcp__browser__run", "web", "agent"];
		for (const name of selected) fake.tools.set(name, { name });
		registerTurnSetup(fake.api, {
			isSubagent,
			profiles: () =>
				new Map([["browser", { name: "browser", description: "", prompt: "", tools: "read,mcp__browser__*" }]]),
		});
		for (const reason of ["startup", "reload", "resume"]) {
			await fake.emit("session_start", { type: "session_start", reason }, {});
			await run(fake);
			expect(fake.api.tools.getActive()).toEqual(selected);
		}
		fake.api.tools.setActive(["read"]);
		await run(fake);
		expect(fake.api.tools.getActive()).toEqual(["read"]);
	});

	it("keeps browser role instructions stable across modes and reads them once per child", async () => {
		const profile = loadProfiles(tmp(), tmp(), false, {}).get("browser")!;
		const sections = [];
		for (const headless of [true, false]) {
			const file = writeRolePrompt({ ...profile, headless }.prompt, tmp());
			vi.stubEnv(ROLE_PROMPT_FILE_ENV, file);
			const fake = fakeHost();
			registerTurnSetup(fake.api, {
				isSubagent: true,
				profiles: () => new Map(),
			});
			const event = {
				systemPromptOptions: {
					sections: {} as Record<string, string>,
					baseSections: {} as Record<string, string>,
					selectedTools: ["file", "agent", "archive", "mcp__browser__run", "web"],
				},
			};
			await fake.emit("before_agent_start", event, {});
			expect(allSections(event).role).toBe(profile.prompt);
			sections.push(allSections(event));
			fs.writeFileSync(file, "changed after this child started");
			await fake.emit("before_agent_start", event, {});
			expect(allSections(event)).toEqual(sections.at(-1));
		}
		expect(sections[0]).toEqual(sections[1]);
	});

	it("keeps native research guidance stable for a fixed selected catalog", async () => {
		const { fake } = setup();
		fake.tools.set(RESEARCH.search, { name: RESEARCH.search });
		const selected = ["read", RESEARCH.search];
		const first = await run(fake, selected);
		expect(await run(fake, selected)).toBe(first);
		setupTurn(fake).reset();
		expect(await run(fake, selected)).toBe(first);
	});
	it("leaves server instructions to the shared MCP section", async () => {
		const { fake } = setup();
		fake.tools.set(RESEARCH.search, {
			name: RESEARCH.search,
			namespace: { name: "mcp__research", instructions: "SERVER_ONLY_INVENTORY" },
		});
		const native = await run(fake, ["read", RESEARCH.search]);
		expect(native).not.toContain("SERVER_ONLY_INVENTORY");
	});
	it("gives every child of one profile the same octocode section, whatever its id, parent and scratch folder", async () => {
		const sectionFor = async (id: string, parent: string, scratch: string) => {
			vi.stubEnv("OCTOCODE_AGENT_ID", id);
			vi.stubEnv("OCTOCODE_PARENT_ID", parent);
			vi.stubEnv("OCTOCODE_AGENT_SCRATCH", scratch);
			const fake = fakeHost();
			for (const name of ["read", "bash", "file"]) fake.tools.set(name, { name });
			registerTurnSetup(fake.api, {
				isSubagent: true,
				profiles: () => new Map(),
			});
			return run(fake, ["read", "file"]);
		};
		const first = await sectionFor(
			"researcher-1a2b",
			"main-aaaaaa",
			"/repo/.octocode/agent/temp/agents/researcher-1a2b",
		);
		const second = await sectionFor(
			"researcher-9z8y",
			"main-bbbbbb",
			"/other/.octocode/agent/temp/agents/researcher-9z8y",
		);
		expect(second).toBe(first);
		expect(first).not.toMatch(/researcher-1a2b|main-aaaaaa|\.octocode\/tmp/);
	});

	it("gives isolated children of one profile byte-identical leading system prompts", async () => {
		const main = "/repo";
		const promptFor = async (worktree: string) => {
			vi.stubEnv("OCTOCODE_WORKTREE_ROOT", worktree);
			vi.stubEnv("OCTOCODE_PROMPT_ROOT", main);
			const fake = fakeHost();
			for (const name of ["read", "bash", "file"]) fake.tools.set(name, { name });
			registerTurnSetup(fake.api, {
				isSubagent: true,
				profiles: () => new Map(),
			});
			// What the session builds before the hook runs: the child's real cwd and its worktree's AGENTS.md.
			const systemPromptOptions = normalizeBuildSystemPromptOptions({
				cwd: `${worktree}/packages/app`,
				selectedTools: ["read", "file"],
				contextFiles: [
					{ path: `${worktree}/AGENTS.md`, content: "Project rules." },
					{ path: "/home/user/.octocode/AGENTS.md", content: "User rules." },
				],
			});
			await fake.emit("before_agent_start", { systemPromptOptions }, {});
			return { prompt: buildSystemPrompt(systemPromptOptions), options: systemPromptOptions };
		};
		const first = await promptFor("/home/user/.octocode/agent/worktrees/aaa/researcher-1a2b");
		const second = await promptFor("/home/user/.octocode/agent/worktrees/aaa/researcher-9z8y");
		expect(second.prompt).toBe(first.prompt);
		expect(first.options.cwd).toBe("/repo/packages/app");
		expect(first.prompt).toContain('<project_instructions path="/repo/AGENTS.md">');
		expect(first.prompt).toContain('<project_instructions path="/home/user/.octocode/AGENTS.md">');
		expect(first.prompt).not.toContain(".octocode/agent/worktrees/");
		expect(first.prompt).not.toContain("researcher-1a2b");
	});
});

describe("the lean main policy", () => {
	useResearchRoles();
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());
	const TOOLS = ["read", "bash", "file", "agent"];
	/** A faux model: only what the policy choice reads. */
	const model = (id: string, contextWindow: number) => ({ provider: "faux", id, contextWindow });
	const ctxFor = (current: ReturnType<typeof model>) => ({
		model: current,
		modelRegistry: { getAvailable: () => [], getProviderKind: () => "API key" },
	});
	/** One request's sections and skill list for a main session on `current`, then the next request after an `agent` call. */
	const request = async (current: ReturnType<typeof model>, settings: Record<string, unknown> = {}) => {
		const fake = fakeHost(settings);
		for (const name of TOOLS) fake.tools.set(name, { name });
		const withhold = vi.fn();
		registerTurnSetup(fake.api, {
			isSubagent: false,
			profiles: () => new Map(),
			skillCatalog: { withhold, invocable: () => [] } as unknown as SkillCatalog,
		});
		const options = {
			sections: {} as Record<string, string>,
			baseSections: {} as Record<string, string>,
			selectedTools: TOOLS,
		};
		const ctx = ctxFor(current);
		await fake.emit("before_agent_start", { systemPromptOptions: options }, ctx);
		const first = { ...options.sections };
		await fake.emit("tool_call", { toolName: "agent", input: { type: "run", task: "look" } }, ctx);
		await fake.emit("turn_prompt", { systemPromptOptions: options }, ctx);
		return { first, after: options.sections, withheld: withhold.mock.calls.at(-1)?.[0] };
	};
	const filled = (sections: Record<string, string>) =>
		Object.keys(sections).filter((name) => sections[name].trim() !== "");

	it("is chosen for a 32k-window model: the lean rules for the user's session, no delegation, children or skill list", async () => {
		const { first, after, withheld } = await request(model("tiny-32k", 32_768));
		expect(filled(first)).toEqual(["lean"]);
		expect(first.lean).toContain("Work on the user's request yourself");
		expect(first.lean).not.toMatch(/You are a subagent|coordinator|reserved for you/);
		expect(after.children ?? "").toBe("");
		expect(withheld, "the skill tool lists no skills").toBe(true);
	});

	it("is chosen for the model subagents.models.small names, whatever its window", async () => {
		const { first } = await request(model("mini", 400_000), { subagents: { models: { small: "faux/mini:low" } } });
		expect(filled(first)).toEqual(["lean"]);
	});

	it("leaves a large-window model the full policy, and the setting overrides the choice either way", async () => {
		const full = await request(model("big", 400_000));
		expect(filled(full.first)).toContain("delegation");
		expect(full.first.lean ?? "").toBe("");
		expect(full.withheld).toBe(false);
		const off = await request(model("tiny-32k", 32_768), { leanPrompt: "off" });
		expect(filled(off.first)).toContain("delegation");
		const on = await request(model("big", 400_000), { leanPrompt: "on" });
		expect(filled(on.first)).toEqual(["lean"]);
	});
});

describe("servers the security review holds back", () => {
	useResearchRoles();
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());
	const status = (fake: ReturnType<typeof fakeHost>, name: string, state: string) =>
		setMcpSessionStatus(fake.api.channels, [
			{ name, enabled: true, state, exposure: "direct", toolCount: 0, source: "test" },
		]);
	const prompt = async (fake: ReturnType<typeof fakeHost>, selectedTools: string[]) => {
		const event = { systemPromptOptions: { sections: {}, baseSections: {}, selectedTools } };
		await fake.emit("before_agent_start", event, {});
		return Object.values(allSections(event)).join("\n\n");
	};
	const host = () => {
		const fake = fakeHost();
		// A real bus: the MCP status snapshot is requested over it.
		fake.flat.events = createEventBus();
		// The research server's tools are registered (deferred until its server connects), not selected.
		for (const name of ["read", "bash", "file", "mcp", "agent", RESEARCH.reader, RESEARCH.search])
			fake.tools.set(name, { name });
		// The shipped profiles: the delegation text names the browser specialist while this agent cannot browse itself.
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => profiles });
		return fake;
	};

	it("route no research through, and offer no browsing of, a server that is not checked", async () => {
		const selected = ["read", "bash", "file", "mcp", "agent"];
		const none = host();
		const baseline = await prompt(none, selected);
		for (const name of [RESEARCH.server, BROWSER_SERVER]) {
			const running = host();
			status(running, name, "starting");
			expect(await prompt(running, selected), `${name} may run`).not.toBe(baseline);
			const held = host();
			status(held, name, "not checked");
			// The model is told nothing a held-back server would serve: the same prompt as without it.
			expect(await prompt(held, selected), `${name} held back`).toBe(baseline);
		}
	});
});
