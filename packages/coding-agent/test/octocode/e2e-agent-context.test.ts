import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENTS, captureAll, type AgentContext } from "./agent-context/capture.ts";
import { isMcpTool } from "./agent-context/analyze.ts";
import { renderMessages, renderSystem, renderTools, systemText } from "./agent-context/render.ts";

/**
 * The full context each agent receives with its first model request, captured from real sessions on a scripted model:
 * the main session as the user starts it and every kind of subagent as `subagents/tool.ts` starts it. The checks below
 * say what each agent's context must hold; every build writes the contexts themselves to `.octocode/tmp/agent-prompts/`.
 */
const POLICY = ["work", "research", "delegation", "safety", "communication"];
const BASE = ["preamble", "tools", "rules", "project_context", "cwd", "environment"];

let contexts: AgentContext[] = [];

beforeAll(async () => {
	contexts = await captureAll();
}, 600_000);

const named = (name: string): AgentContext => {
	const found = contexts.find((context) => context.name === name);
	if (!found) throw new Error(`No captured context for ${name}`);
	return found;
};

const sectionNames = (context: AgentContext): string[] => context.sections.map((section) => section.name);

it("shares complete native and research-tool declarations before role-specific tools", () => {
	const main = named("main");
	const child = named("general");
	const shared = [
		"bash",
		"file",
		"web",
		"mcp",
		"timer",
		...main.tools.filter((tool) => isMcpTool(tool.name)).map((tool) => tool.name),
	];
	expect(shared.length).toBeGreaterThan(4);
	expect(main.tools.slice(0, shared.length).map((tool) => tool.name)).toEqual(shared);
	expect(child.tools.slice(0, shared.length).map((tool) => tool.name)).toEqual(shared);
	expect(JSON.stringify(child.tools.slice(0, shared.length))).toBe(JSON.stringify(main.tools.slice(0, shared.length)));
	// Archive differs by role and must follow that prefix.
	expect(main.tools.find((tool) => tool.name === "archive")?.parameters).not.toEqual(
		child.tools.find((tool) => tool.name === "archive")?.parameters,
	);
});

describe.each(AGENTS)("$name context", (agent) => {
	const context = () => named(agent.name);

	it("has the sections its kind of agent gets", () => {
		const names = sectionNames(context());
		expect(names).toEqual(expect.arrayContaining(BASE));
		expect(names, "text outside every section").not.toContain("(system text outside a section)");
		if (agent.kind === "main") {
			expect(names).toEqual(expect.arrayContaining([...POLICY, "mcps", "skills", "docs"]));
			expect(names).not.toContain("role");
			expect(systemText(context())).not.toContain("You are a subagent");
			return;
		}
		// A child: the subagent policy, no docs section, and a role section only for a role.
		expect(names).not.toContain("docs");
		expect(systemText(context())).toContain("You are a subagent");
		expect(names.includes("role")).toBe(agent.role !== undefined);
		if (agent.role === "lean") {
			expect(names).toContain("lean");
			for (const policy of POLICY) expect(names, `the full policy ${policy} in a lean child`).not.toContain(policy);
		} else if (["researcher", "reviewer", "browser"].includes(agent.role ?? "")) {
			// A read-only child's compact core (`policy/readonly.md`) replaces the work, delegation and safety sections.
			const core = POLICY.filter((name) => name !== "delegation" && name !== "safety");
			expect(names).toEqual(expect.arrayContaining(core));
			expect(names).not.toContain("delegation");
			expect(names).not.toContain("safety");
		} else {
			expect(names).toEqual(expect.arrayContaining(POLICY));
			expect(names).not.toContain("lean");
		}
	});

	it("has the Octocode MCP section and tools wherever the server is exposed", () => {
		const names = context().tools.map((tool) => tool.name);
		if (agent.role === "lean") {
			// A lean child runs without any MCP server.
			expect(sectionNames(context())).not.toContain("mcps");
			expect(names.filter(isMcpTool)).toEqual([]);
			return;
		}
		expect(sectionNames(context())).toContain("mcps");
		expect(names).toContain("mcp__octocode__localSearch");
		expect(names).toContain("mcp__octocode__localFetch");
	});

	it("declares every tool with a description and an object schema", () => {
		expect(context().tools.length).toBeGreaterThan(0);
		for (const tool of context().tools) {
			expect(tool.description.trim(), `${tool.name} description`).not.toBe("");
			expect(tool.parameters, `${tool.name} schema`).toMatchObject({ type: "object" });
		}
	});

	it("has the protocol only where it can use it", () => {
		const text = systemText(context());
		const agentTool = JSON.stringify(context().tools.find((tool) => tool.name === "agent") ?? {});
		if (agent.kind === "main") {
			expect(text).toContain("only you reach other Octocode processes");
			expect(agentTool).toContain("Also another Octocode process by its name");
			expect(agentTool).toContain("a linked worktree's branch");
			return;
		}
		expect(text).not.toContain("only you reach other Octocode processes");
		expect(agentTool).not.toContain("Also another Octocode process by its name");
		expect(agentTool).not.toContain("a linked worktree's branch");
	});

	it("starts from the message the agent is given", () => {
		const { messages } = context();
		expect(messages.map((message) => message.role)).toEqual(["user"]);
		if (agent.kind === "main") return;
		// A child's first message is its task with its identity and the report contract the parent parses.
		expect(messages[0].text).toContain("## You");
		expect(messages[0].text).toContain("## Report");
		expect(messages[0].text).toContain("child-example");
	});

	it("names no machine's paths or date", () => {
		for (const text of [renderSystem(context()), renderTools(context()), renderMessages(context())]) {
			expect(text).not.toMatch(/\/(?:Users|home|private|var)\//);
			expect(text).not.toMatch(/^Date: \d{4}-/m);
		}
	});
});

describe("the real assembled prefix of a main session", () => {
	// What a main session in this repository sends before the user's first word: the captured system text, each tool's name,
	// description and compact parameter JSON (what the provider receives, not the pretty-printed Markdown of the prompt
	// files), plus this repository's AGENTS.md, for which the capture uses a stand-in. The tools and `mcps` block are
	// declared up front by decision, so this does not ask for a cut: it makes growth a decision too.
	// Measured 111,408 bytes on 2026-11-04 from the baseline capture (.octocode/tmp/agent-prompts-baseline/main: system
	// 70,237, tools 27,092, AGENTS.md 14,079), plus 7.3% for what lands with it. The earlier metric (renderSystem + renderTools
	// + AGENTS.md, with schemas pretty-printed inside fences) read 121,193 for that same capture, so this count is stricter
	// by construction: it drops about 9.7 KB of formatting nobody receives and the ceiling is set from the new reading.
	// 122,191 (2026-11-05, B55): plus 2,650 for the bash description's CLI guide with the probed host (2,569 measured),
	// requested by the user.
	// 122,601 (2026-11-05, B59, requested by the user): plus 410 measured in main's capture for the `octocode` CLI: the
	// research line (318), its place in the fallback (25) and the CLI guide's Scope clause (67).
	// 125_500 (2026-11-05, measured 124,028: system 24,462, tools 85,079, AGENTS.md 14,487; MCP declared mode, requested by the
	// user): every MCP tool is declared with the server's own description and full JSON Schema, as Claude Code and Codex send
	// them, and the system prompt keeps only each server's instructions. The same server text moves from system (68,532 before)
	// to tools (39,517 before), and the schema as sent is longer than the typed notation it replaced. Server text is not
	// ours to trim (M14); our own text keeps its cap in `e2e.test.ts` and `prompt-size.test.ts`.
	const REAL_PREFIX_CEILING = 125_500;

	it("stays under its ceiling", () => {
		const main = named("main");
		const parts = {
			system: Buffer.byteLength(systemText(main)),
			tools: main.tools.reduce(
				(sum, tool) =>
					sum +
					Buffer.byteLength(tool.name) +
					Buffer.byteLength(tool.description) +
					Buffer.byteLength(JSON.stringify(tool.parameters)),
				0,
			),
			agents: fs.statSync(fileURLToPath(new URL("../../../../AGENTS.md", import.meta.url))).size,
		};
		const total = parts.system + parts.tools + parts.agents;
		// Not vacuous: a capture that lost its `mcps` block or its tools would pass any ceiling.
		// The MCP tools' descriptions and schemas are in the declarations (`tools`), not the system prompt's `mcps` block.
		expect(parts.system).toBeGreaterThan(15_000);
		expect(parts.system + parts.tools).toBeGreaterThan(60_000);
		expect(parts.tools).toBeGreaterThan(15_000);
		expect(
			total,
			`first-request prefix grew to ${total} bytes (${JSON.stringify(parts)}); if the growth is worth paying on every request, raise REAL_PREFIX_CEILING and say why`,
		).toBeLessThanOrEqual(REAL_PREFIX_CEILING);
	});
});
