import fs from "node:fs";
import { ROLE_PROMPT_FILE_ENV, writeRolePrompt } from "../../src/octocode/instructions/role.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../../src/core/system-prompt.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";
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
		expect(fake.api.getActiveTools()).toEqual(["read", "bash", "file"]);
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
		expect(fake.api.getActiveTools()).toEqual(["read", "bash", "file"]);
		fake.api.setActiveTools(["read", "bash", "edit", "write", "file"]);
		await fake.emit("session_start", { type: "session_start", reason: "reload" }, {});
		expect(fake.api.getActiveTools()).toEqual(["read", "bash", "edit", "write", "file"]);
		// Custom tools remain registered even if they use former built-in names.
		await fake.emit("session_start", { type: "session_start", reason: "resume" }, {});
		expect(fake.api.getActiveTools()).toEqual(["read", "bash", "edit", "write", "file"]);
	});

	it("keeps edit/write explicitly selected by the session", async () => {
		const { fake } = setup();
		fake.api.setActiveTools(["read", "bash", "edit", "write", "file"]);
		process.argv = ["node", "octocode", "--tools", "read,edit,write,file"];
		await run(fake);
		expect(fake.api.getActiveTools()).toEqual(["read", "bash", "edit", "write", "file"]);
	});

	it.each(["edit", "+edit"])("does not synthesize a removed tool from the %s setting", async (entry) => {
		const { fake } = setup();
		vi.spyOn(fake.api, "getSettings").mockReturnValue({ defaultTools: [entry, "-write"] });
		await run(fake);
		expect(fake.api.getActiveTools()).toEqual(["read", "bash", "file"]);
	});

	it("does not inherit another session's tool choices from the host command line", async () => {
		const { fake } = setup();
		process.argv = ["node", "host", "--tools", "read,edit,write,file"];
		await run(fake);
		expect(fake.api.getActiveTools()).toEqual(["read", "bash", "file"]);
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
			expect(fake.api.getActiveTools()).toEqual(selected);
		}
		fake.api.setActiveTools(["read"]);
		await run(fake);
		expect(fake.api.getActiveTools()).toEqual(["read"]);
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
			"/repo/.octocode/code/temp/agents/researcher-1a2b",
		);
		const second = await sectionFor(
			"researcher-9z8y",
			"main-bbbbbb",
			"/other/.octocode/code/temp/agents/researcher-9z8y",
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
		const first = await promptFor("/home/user/.octocode/worktrees/aaa/researcher-1a2b");
		const second = await promptFor("/home/user/.octocode/worktrees/aaa/researcher-9z8y");
		expect(second.prompt).toBe(first.prompt);
		expect(first.options.cwd).toBe("/repo/packages/app");
		expect(first.prompt).toContain('<project_instructions path="/repo/AGENTS.md">');
		expect(first.prompt).toContain('<project_instructions path="/home/user/.octocode/AGENTS.md">');
		expect(first.prompt).not.toContain(".octocode/worktrees/");
		expect(first.prompt).not.toContain("researcher-1a2b");
	});
});
