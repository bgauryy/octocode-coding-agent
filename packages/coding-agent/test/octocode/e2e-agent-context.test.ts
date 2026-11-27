import fs from "node:fs";
import { RESEARCH } from "./research-roles.ts";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENTS, captureAll, type AgentContext } from "./agent-context/capture.ts";
import { isMcpTool } from "./agent-context/analyze.ts";
import { renderMessages, renderSystem, renderTools, systemText } from "./agent-context/render.ts";
import { loadProfiles, profileSelectsTool } from "../../src/octocode/subagents/profiles.ts";

/**
 * The full context each agent receives with its first model request, captured from real sessions on a scripted model:
 * the main session as the user starts it and every kind of subagent as `subagents/tool.ts` starts it. The checks below
 * say what each agent's context must hold; every build writes the contexts themselves to `.octocode/agent/tmp/agent-prompts/`.
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

/** The bundled roles (an empty folder adds no project or home profile). */
const bundledProfiles = loadProfiles(os.tmpdir(), os.tmpdir(), false, {});

/** Whether an agent's tool selection admits the Octocode MCP server's tools, which every agent gets by default. */
const admitsOctocode = (role: string | undefined): boolean => {
	if (role === undefined) return true;
	const probe = RESEARCH.reader;
	return profileSelectsTool(bundledProfiles.get(role), probe, [probe]);
};

it("shares complete native and research-tool declarations before role-specific tools", () => {
	const main = named("main");
	const child = named("general");
	// `web` is declared for every role (deferred until this folder uses it), so it is part of the shared prefix.
	const shared = [
		"bash",
		"file",
		"web",
		"mcp",
		"notify",
		...main.tools.filter((tool) => isMcpTool(tool.name)).map((tool) => tool.name),
	];
	expect(shared.length).toBeGreaterThan(4);
	expect(main.tools.slice(0, shared.length).map((tool) => tool.name)).toEqual(shared);
	expect(child.tools.slice(0, shared.length).map((tool) => tool.name)).toEqual(shared);
	expect(JSON.stringify(child.tools.slice(0, shared.length))).toBe(JSON.stringify(main.tools.slice(0, shared.length)));
	// Archive differs by role, so it must not sit in that prefix: on this transport it is on demand, listed in `<tools>`
	// and declared only once the session uses it.
	for (const context of [main, child]) {
		expect(context.tools.map((tool) => tool.name)).not.toContain("archive");
		expect(context.sections.find((section) => section.name === "tools")?.text).toMatch(/\n- archive: \S/);
	}
});

describe.each(AGENTS)("$name context", (agent) => {
	const context = () => named(agent.name);

	it("has the sections its kind of agent gets", () => {
		const names = sectionNames(context());
		// `environment` is sent only as its `environment:<field>` parts; `project_context` and `mcps` add parts.
		expect(names.map((name) => name.split(":")[0])).toEqual(expect.arrayContaining(BASE));
		expect(names, "text outside every section").not.toContain("(system text outside a section)");
		if (agent.kind === "main") {
			expect(names).toEqual(expect.arrayContaining([...POLICY, "mcps", "docs"]));
			expect(names).not.toContain("skills");
			expect(names).not.toContain("subagent");
			expect(names).not.toContain("role");
			return;
		}
		// A child: the subagent policy, no docs section, and a role section only for a role.
		expect(names).not.toContain("docs");
		expect(names.includes("role")).toBe(agent.role !== undefined);
		if (agent.role === "lean") {
			expect(names).toContain("lean");
			for (const policy of POLICY) expect(names, `the full policy ${policy} in a lean child`).not.toContain(policy);
		} else if (["researcher", "reviewer", "browser"].includes(agent.role ?? "")) {
			// A read-only child's compact core (`policy/readonly.md`) replaces the change-code chunk of the work section.
			const core = POLICY.filter((name) => name !== "delegation");
			expect(names).toEqual(expect.arrayContaining(core));
			expect(names).not.toContain("delegation");
			expect(names).toContain("subagent");
		} else {
			// A child that may write: its policy is `<subagent>`; `<delegation>` is the main session's.
			expect(names).toEqual(expect.arrayContaining(POLICY.map((name) => (name === "delegation" ? "subagent" : name))));
			expect(names).not.toContain("delegation");
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
		if (!admitsOctocode(agent.role)) {
			// A role whose tools leave out the research server gets neither its tools nor its block.
			expect(names.filter((name) => name.startsWith(RESEARCH.prefix))).toEqual([]);
			expect(sectionNames(context())).not.toContain(`mcps:${RESEARCH.server}`);
			return;
		}
		expect(sectionNames(context())).toContain("mcps");
		expect(names).toContain(RESEARCH.reader);
		for (const name of RESEARCH.search) expect(names).toContain(name);
	});

	it("declares every tool with a description and an object schema", () => {
		expect(context().tools.length).toBeGreaterThan(0);
		for (const tool of context().tools) {
			expect(tool.description.trim(), `${tool.name} description`).not.toBe("");
			expect(tool.parameters, `${tool.name} schema`).toMatchObject({ type: "object" });
		}
	});

	it("starts from the message the agent is given", () => {
		const { messages } = context();
		expect(messages.map((message) => message.role)).toEqual(["user"]);
		if (agent.kind === "main") return;
		// A child's first message is its task with its identity and the report contract the parent parses.
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
	// What a main session in this repository sends before the user's first word, counting the text Octocode owns: the
	// captured system text without its `mcps` section (each server's instructions, verbatim), each native tool's name, description and
	// compact parameter JSON as the provider receives it (the `skill` tool without its bundled Octocode skills, verbatim from the
	// sibling release), and this repository's AGENTS.md (the capture uses a stand-in).
	// MCP server text is the server's own and never rewritten (M14), so it is reported in the message, not capped here;
	// `prompt-size.test.ts` and `served-first-request.test.ts` cap what each role pays for it. The tools and `mcps` block
	// are declared up front by decision, so this does not ask for a cut: it makes growth a decision too. The ceiling sits
	// just above its reading (45,487: system 18,013, native tools 18,655, AGENTS.md 8,819); raise it only for growth worth
	// paying on every request, and say why.
	const OWN_PREFIX_CEILING = 45_600;

	it("stays under its ceiling", () => {
		const main = named("main");
		const declared = (tool: (typeof main.tools)[number]) =>
			Buffer.byteLength(tool.name) +
			Buffer.byteLength(tool.description) +
			Buffer.byteLength(JSON.stringify(tool.parameters));
		// The `mcps` section, with each server's block when they are sections of their own (`mcps:<server>`).
		const mcpsSection = main.sections
			.filter((section) => section.name === "mcps" || section.name.startsWith("mcps:"))
			.reduce((sum, section) => sum + Buffer.byteLength(section.text), 0);
		// The bundled Octocode skills' names and descriptions come verbatim from the sibling release, like server text. They
		// are listed in the `skill` tool's description, the rest of which (the core skills, the usage text) is Octocode's own.
		const skillTool = main.tools.find((tool) => tool.name === "skill");
		const siblingSkills = Buffer.byteLength(
			/<octocode_skills>[\s\S]*?<\/octocode_skills>/.exec(skillTool?.description ?? "")?.[0] ?? "",
		);
		const parts = {
			system: Buffer.byteLength(systemText(main)) - mcpsSection,
			tools:
				main.tools.filter((tool) => !isMcpTool(tool.name)).reduce((sum, tool) => sum + declared(tool), 0) -
				siblingSkills,
			agents: fs.statSync(fileURLToPath(new URL("../../../../AGENTS.md", import.meta.url))).size,
		};
		const server = {
			skills: siblingSkills,
			instructions: mcpsSection,
			tools: main.tools.filter((tool) => isMcpTool(tool.name)).reduce((sum, tool) => sum + declared(tool), 0),
		};
		const own = parts.system + parts.tools + parts.agents;
		// Not vacuous: a capture that lost its sections, its native tools or its MCP servers would pass any ceiling.
		// The skill catalog lives in the `skill` tool's description (counted in `parts.tools`), not in the system text, so the
		// system floor sits under the section total (13,095 measured) and still fails if the policy sections go missing.
		expect(parts.system).toBeGreaterThan(12_000);
		expect(parts.tools).toBeGreaterThan(15_000);
		expect(server.instructions).toBeGreaterThan(0);
		expect(server.skills).toBeGreaterThan(0);
		expect(skillTool?.description).toContain("<core_skills>");
		expect(systemText(main)).not.toContain("<octocode_skills>");
		expect(server.tools).toBeGreaterThan(0);
		expect(
			own,
			`first-request prefix text Octocode owns grew to ${own} bytes (${JSON.stringify(parts)}; sibling text (bundled skills, MCP servers), not capped: ${JSON.stringify(server)}); if the growth is worth paying on every request, raise OWN_PREFIX_CEILING and say why`,
		).toBeLessThanOrEqual(OWN_PREFIX_CEILING);
	});
});
