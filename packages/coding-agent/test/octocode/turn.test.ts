import fs from "node:fs";
import { ROLE_PROMPT_FILE_ENV, writeRolePrompt } from "../../src/octocode/instructions/role.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OctocodeOwner } from "../../src/octocode/mcp/octocode.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeOctocode, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

describe("registerTurnSetup", () => {
	const setup = (owner?: OctocodeOwner) => {
		const fake = fakePi();
		for (const name of ["read", "bash", "file"]) fake.tools.set(name, { name });
		const { mcp, state } = fakeOctocode(owner);
		const ready = mcp.ready;
		mcp.ready = async (ctx) => {
			const connected = await ready(ctx);
			if (connected) fake.tools.set("mcp__octocode__localSearch", { name: "mcp__octocode__localSearch" });
			return connected;
		};
		const turn = registerTurnSetup(fake.pi, { isSubagent: false, profiles: () => new Map(), octocode: mcp });
		turns.set(fake, turn);
		return { fake, turn, state };
	};
	const turns = new Map<ReturnType<typeof fakePi>, ReturnType<typeof registerTurnSetup>>();
	const setupTurn = (fake: ReturnType<typeof fakePi>) => turns.get(fake)!;
	const run = async (fake: ReturnType<typeof fakePi>, selectedTools?: string[]) => {
		const event = {
			systemPromptOptions: { sections: {} as Record<string, string>, ...(selectedTools ? { selectedTools } : {}) },
		};
		await fake.emit("before_agent_start", event, {});
		return event.systemPromptOptions.sections.octocode;
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

	it("routes deferred Octocode research through native discovery without suggesting scripts", async () => {
		const { fake } = setup({ by: "off" });
		fake.tools.set("tool_search", { name: "tool_search" });
		fake.tools.set("mcp__octocode__ghSearchCode", { name: "mcp__octocode__ghSearchCode", exposure: "deferred" });
		fake.pi.setActiveTools(["tool_search"]);
		const prompt = await run(fake);
		expect(prompt).toContain("Use Octocode MCP");
		expect(prompt).not.toContain("are called from `codemode`");
	});

	it("uses the core tool set at session start and leaves the active set alone per turn", async () => {
		const { fake } = setup();
		process.argv = ["node", "pi"];
		expect(fake.pi.getActiveTools()).toEqual(["read", "bash", "file"]);
		const event = {
			systemPromptOptions: { sections: {} as Record<string, string>, selectedTools: ["read", "edit"] },
		};
		await fake.emit("before_agent_start", event, {});
		expect(event.systemPromptOptions.selectedTools).toEqual(["read", "edit"]);
	});

	it("keeps read-only shell restrictions when PowerShell is the only shell", async () => {
		const { fake } = setup({ by: "off" });
		const prompt = await run(fake, ["read", "powershell"]);
		expect(prompt).toContain("Run only read-only commands.");
		expect(await run(fake, ["read"])).not.toContain("Run only read-only commands.");
	});

	it("keeps custom tools across reload and resume without name-based pruning", async () => {
		const { fake } = setup();
		process.argv = ["node", "pi"];
		await fake.emit("session_start", { type: "session_start", reason: "startup" }, {});
		expect(fake.pi.getActiveTools()).toEqual(["read", "bash", "file"]);
		fake.pi.setActiveTools(["read", "bash", "edit", "write", "file"]);
		await fake.emit("session_start", { type: "session_start", reason: "reload" }, {});
		expect(fake.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write", "file"]);
		// Custom tools remain registered even if they use former built-in names.
		await fake.emit("session_start", { type: "session_start", reason: "resume" }, {});
		expect(fake.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write", "file"]);
	});

	it("keeps edit/write explicitly selected by the session", async () => {
		const { fake } = setup({ by: "off" });
		fake.pi.setActiveTools(["read", "bash", "edit", "write", "file"]);
		process.argv = ["node", "pi", "--tools", "read,edit,write,file"];
		await run(fake);
		expect(fake.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write", "file"]);
	});

	it.each(["edit", "+edit"])("does not synthesize a removed tool from the %s setting", async (entry) => {
		const { fake } = setup({ by: "off" });
		vi.spyOn(fake.pi, "getSettings").mockReturnValue({ defaultTools: [entry, "-write"] });
		await run(fake);
		expect(fake.pi.getActiveTools()).toEqual(["read", "bash", "file"]);
	});

	it("does not inherit another session's tool choices from the host command line", async () => {
		const { fake } = setup({ by: "off" });
		process.argv = ["node", "host", "--tools", "read,edit,write,file"];
		await run(fake);
		expect(fake.pi.getActiveTools()).toEqual(["read", "bash", "file"]);
	});

	it.each([false, true])("preserves browser and web selections for isSubagent=%s", async (isSubagent) => {
		const fake = fakePi();
		const selected = ["read", "file", "browser", "web", "agent"];
		for (const name of selected) fake.tools.set(name, { name });
		registerTurnSetup(fake.pi, {
			isSubagent,
			profiles: () => new Map([["browser", { name: "browser", description: "", prompt: "", tools: "read,browser" }]]),
			octocode: fakeOctocode({ by: "off" }).mcp,
		});
		for (const reason of ["startup", "reload", "resume"]) {
			await fake.emit("session_start", { type: "session_start", reason }, {});
			await run(fake);
			expect(fake.pi.getActiveTools()).toEqual(selected);
		}
		fake.pi.setActiveTools(["read"]);
		await run(fake);
		expect(fake.pi.getActiveTools()).toEqual(["read"]);
	});

	it("routes browser work to the specialist only when the main agent can delegate and has no browser", async () => {
		const fake = fakePi();
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		registerTurnSetup(fake.pi, {
			isSubagent: false,
			profiles: () => profiles,
			octocode: fakeOctocode({ by: "off" }).mcp,
		});
		expect(await run(fake, ["agent", "file", "web"])).toContain("Delegate browser interaction to `browser`");
		expect(await run(fake, ["agent", "file", "browser"])).not.toContain("Delegate browser interaction");
		expect(await run(fake, ["file", "web"])).not.toContain("Delegate browser interaction");
	});

	it("keeps browser role instructions stable across modes and reads them once per child", async () => {
		const profile = loadProfiles(tmp(), tmp(), false, {}).get("browser")!;
		const sections = [];
		for (const headless of [true, false]) {
			const file = writeRolePrompt(profile.prompt, tmp());
			vi.stubEnv(ROLE_PROMPT_FILE_ENV, file);
			vi.stubEnv("OCTOCODE_BROWSER_VISIBLE", headless ? "" : "1");
			const fake = fakePi();
			registerTurnSetup(fake.pi, {
				isSubagent: true,
				profiles: () => new Map(),
				octocode: fakeOctocode({ by: "off" }).mcp,
			});
			const event = {
				systemPromptOptions: {
					sections: {} as Record<string, string>,
					selectedTools: ["file", "agent", "archive", "browser", "web"],
				},
			};
			await fake.emit("before_agent_start", event, {});
			expect(event.systemPromptOptions.sections.role).toBe(profile.prompt);
			sections.push({ ...event.systemPromptOptions.sections });
			fs.writeFileSync(file, "changed after this child started");
			await fake.emit("before_agent_start", event, {});
			expect(event.systemPromptOptions.sections).toEqual(sections.at(-1));
		}
		expect(sections[0]).toEqual(sections[1]);
	});

	it("prefers Octocode MCP from the first turn once its server is connected, though its tools register after the snapshot", async () => {
		const { fake, state } = setup();
		// Octocode snapshots selectedTools before before_agent_start; the extension's client connects (and registers) before it.
		const first = await run(fake, ["read"]);
		expect(first).toContain("Use Octocode MCP (`mcp__octocode__*`");
		// Every Octocode tool is declared: no tool_search step to mention.
		expect(first).not.toContain("`tool_search`");
		fake.tools.set("mcp__octocode__localSearch", { name: "mcp__octocode__localSearch" });
		// The section stays byte-identical once the tools appear, so the provider cache holds.
		expect(await run(fake, ["read", "mcp__octocode__localSearch"])).toBe(first);
		// Checking a connected client preserves the exact section while its tools remain available.
		expect(state.readyCalls).toBe(2);
	});

	it("carries the Octocode server instructions whole in the first prompt, then keeps the section stable", async () => {
		const { fake, state } = setup();
		state.instructions =
			"Loop: SCOPE → ORIENT → SEARCH.\nReuse returned data.next.* exactly.\nEmpty does not prove absence.";
		const first = await run(fake, ["read"]);
		expect(first).toContain(
			`# Using Octocode MCP tools\nThese instructions govern code research, not writing from supplied facts.\n${state.instructions}\n`,
		);
		expect(first.indexOf("# Research")).toBeLessThan(first.indexOf("# Using Octocode MCP tools"));
		expect(first.indexOf("# Using Octocode MCP tools")).toBeLessThan(first.indexOf("# Safety"));
		expect(await run(fake, ["read", "mcp__octocode__localSearch"])).toBe(first);
	});

	it("leaves Octocode out of the prompt while the server is not connected, and asks again on a later prompt", async () => {
		const { fake, state } = setup();
		state.connected = false;
		state.instructions = "Reuse next.*";
		const failed = await run(fake, ["read"]);
		expect(failed).not.toContain("Octocode MCP");
		expect(failed).not.toContain("server instructions");
		state.connected = true;
		expect(await run(fake, ["read"])).toContain(
			"# Using Octocode MCP tools\nThese instructions govern code research, not writing from supplied facts.\nReuse next.*",
		);
		expect(state.readyCalls).toBe(2);
		// A session reset forgets what was seen: the next session decides for itself.
		state.connected = false;
		expect(await run(fake, ["read"])).not.toContain("Use Octocode MCP");
		setupTurn(fake).reset();
		expect(await run(fake, ["read"])).not.toContain("Octocode MCP");
	});

	it("follows a user-owned server's available tools, not merely its enabled configuration", async () => {
		const { fake, state } = setup({ by: "user", enabled: true });
		const own = await run(fake, ["read"]);
		expect(own).not.toContain("Use Octocode MCP");
		expect(await run(fake, ["read", "mcp__octocode__localSearch"])).toContain("Use Octocode MCP");
		expect(own).not.toContain("server instructions");
		expect(state.readyCalls).toBe(0);
		// An entry that disables the server leaves Octocode out, unless its tools are there anyway.
		const disabled = setup({ by: "user", enabled: false });
		expect(await run(disabled.fake, ["read"])).not.toContain("Octocode MCP");
		expect(await run(disabled.fake, ["read", "mcp__octocode__localSearch"])).toContain("Use Octocode MCP");
	});

	it("with the server off, follows Octocode tools that are present and removes guidance when deselected", async () => {
		const { fake, state } = setup({ by: "off" });
		expect(await run(fake, ["read"])).not.toContain("Octocode MCP");
		const withTools = await run(fake, ["read", "mcp__octocode__localSearch"]);
		expect(withTools).toContain("Use Octocode MCP");
		expect(await run(fake, ["read"])).not.toContain("Use Octocode MCP");
		expect(state.readyCalls).toBe(0);
	});

	it("gives every child of one profile the same octocode section, whatever its id, parent and scratch folder", async () => {
		const sectionFor = async (id: string, parent: string, scratch: string, collaborate = false) => {
			vi.stubEnv("OCTOCODE_AGENT_ID", id);
			vi.stubEnv("OCTOCODE_PARENT_ID", parent);
			vi.stubEnv("OCTOCODE_AGENT_SCRATCH", scratch);
			vi.stubEnv("OCTOCODE_AGENT_COLLABORATE", collaborate ? "1" : "");
			const fake = fakePi();
			for (const name of ["read", "bash", "file"]) fake.tools.set(name, { name });
			registerTurnSetup(fake.pi, {
				isSubagent: true,
				profiles: () => new Map(),
				octocode: fakeOctocode({ by: "off" }).mcp,
			});
			return run(fake, ["read", "file"]);
		};
		const first = await sectionFor("researcher-1a2b", "main-aaaaaa", "/repo/.octocode/tmp/agents/researcher-1a2b");
		const second = await sectionFor("researcher-9z8y", "main-bbbbbb", "/other/.octocode/tmp/agents/researcher-9z8y");
		expect(second).toBe(first);
		expect(first).not.toMatch(/researcher-1a2b|main-aaaaaa|\.octocode\/tmp/);
		// Collaboration changes the section for every child alike, not per child.
		const team = await sectionFor("a-1", "main-aaaaaa", "/x/a-1", true);
		expect(team).toBe(await sectionFor("b-2", "main-bbbbbb", "/y/b-2", true));
		expect(team).not.toBe(first);
	});
});
