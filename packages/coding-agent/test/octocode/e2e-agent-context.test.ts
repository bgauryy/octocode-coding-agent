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
			expect(names).not.toContain("coordinator");
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
			// A read-only child's compact core (`policy/readonly.md`) replaces the work, coordinator and safety sections.
			const core = POLICY.filter((name) => name !== "delegation" && name !== "safety");
			expect(names).toEqual(expect.arrayContaining(core));
			expect(names).not.toContain("delegation");
			expect(names).not.toContain("coordinator");
			expect(names).not.toContain("safety");
		} else {
			// A child that may write: its subagent policy is `<coordinator>`; `<delegation>` is the main session's.
			expect(names).toEqual(
				expect.arrayContaining(POLICY.map((name) => (name === "delegation" ? "coordinator" : name))),
			);
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
	// What a main session in this repository sends before the user's first word: the captured system text, each tool's name,
	// description and compact parameter JSON (what the provider receives, not the pretty-printed Markdown of the prompt
	// files), plus this repository's AGENTS.md, for which the capture uses a stand-in. The tools and `mcps` block are
	// declared up front by decision, so this does not ask for a cut: it makes growth a decision too.
	// Measured 111,408 bytes from the baseline capture (system
	// 70,237, tools 27,092, AGENTS.md 14,079), plus 7.3% for what lands with it. The earlier metric (renderSystem + renderTools
	// + AGENTS.md, with schemas pretty-printed inside fences) read 121,193 for that same capture, so this count is stricter
	// by construction: it drops about 9.7 KB of formatting nobody receives and the ceiling is set from the new reading.
	// 122,191: plus 2,650 for the bash description's CLI guide with the probed host (2,569 measured),
	// requested by the user.
	// 122,601 (requested by the user): plus 410 measured in main's capture for the `octocode` CLI: the
	// research line (318), its place in the fallback (25) and the CLI guide's Scope clause (67).
	// 125_500 (measured 124,028: system 24,462, tools 85,079, AGENTS.md 14,487; MCP declared mode, requested by the
	// user): every MCP tool is declared with the server's own description and full JSON Schema, as Claude Code and Codex send
	// them, and the system prompt keeps only each server's instructions. The same server text moves from system (68,532 before)
	// to tools (39,517 before), and the schema as sent is longer than the typed notation it replaced. Server text is not
	// ours to trim (M14); our own text keeps its cap in `e2e.test.ts` and `prompt-size.test.ts`.
	// 131_500 (measured 131,414: system 24,915, tools 91,918, AGENTS.md 14,581): the sibling server added its
	// `securityCheck` tool (3,497 declared bytes, server text), our itemized growth (+2,726, capped in
	// `e2e.test.ts`), and about 1,160 from other server and AGENTS.md text.
	// 132_624 (measured 132,538: system 24,970, tools 92,987, AGENTS.md 14,581): the timer tool's closed
	// `until` list, +953 in tools (`prompt-size.test.ts` itemizes it); the other +171 since 131,414 came from concurrent
	// edits. Slack over the measurement is 86, as before.
	// 118_033 (measured 117,947: system 30,157, tools 80,117, AGENTS.md 7,673): the
	// shorter AGENTS.md, `reason` described once in policy, the policy tables and the other wave-1 prompt changes (skill
	// listing, edit digest, MCP exposure). Slack stays 86.
	// 118_443 (measured 118,357: system 30,567, tools 80,117, AGENTS.md 7,673): the user-requested rules for output form
	// by data shape, brevity, established solutions, comments and docs (+410 in system, net of offsetting cuts).
	// Slack stays 86.
	// 119_282 (measured 119,196: system 30,808, tools 80,715, AGENTS.md 7,673): the user-requested challenge and
	// numbers rules (+241 in system) and the rebuilt sibling server's tool text (+598 in tools). Slack stays 86.
	// 119_938 (119,196 + 656): the user-requested rule for messaging an outside CLI session through a one-shot proxy
	// of its own CLI (+656 in system). Slack stays 86.
	// 119_938 was the last ceiling over the whole prefix, server text included.
	// From here the ceiling caps only the text Octocode owns: the system prompt without its `mcps` section (each server's
	// instructions, verbatim), the native tool declarations and AGENTS.md. MCP server text (the `mcps` section and every
	// `mcp__*` declaration) is the server's own, never rewritten (M14), and changed whenever the sibling server was rebuilt,
	// which broke this check on text we cannot trim. It is reported in the message, not capped; our own wording around it
	// keeps its itemized caps in `e2e.test.ts` and `prompt-size.test.ts`.
	// 57_603 (measured 57,517: system without `mcps` 24,868, native tools 24,794, AGENTS.md 7,855; server text then 4,214
	// instructions and 61,570 declared). Slack stays 86.
	// 57_952 (57,603 + 349): AGENTS.md's owner table names the session codec, `composedLater`, the `@` file index, mcp's
	// `api.ts`, the telemetry recorder and the theme UI kit, and the MCP boundary check (requested by the user). Slack stays 86.
	// 58_019 (57,952 + 67): AGENTS.md names the web daemon as `/web` and the per-session server as its fallback only.
	// 53_730 (measured 53,644: system without `mcps` 25,101, native tools 20,272, AGENTS.md 8,271; server text 4,792
	// instructions and 12,242 declared): lowered to the reading. The bundled `octocode` server follows the deferred
	// default, so the tool list no longer names it, and native tools and AGENTS.md shrank since. Slack stays 86.
	// 48_625 (measured 48,539: system without `mcps` and `<octocode_skills>` 19,996, native tools 20,272, AGENTS.md 8,271):
	// the bundled Octocode skills' names and descriptions come verbatim from the sibling release and grew with its rebuild
	// (+1,347 for `octocode-graph` and reworded descriptions), which broke this check on text this repository does not
	// write. They are now reported with the server text, not capped (6,452 at this reading); Octocode's own text is
	// unchanged. Slack stays 86.
	// Shared policy, tool guidance and native skill descriptions now leave less headroom for regrowth.
	const OWN_PREFIX_CEILING = 47_625;

	it("stays under its ceiling", () => {
		const main = named("main");
		const declared = (tool: (typeof main.tools)[number]) =>
			Buffer.byteLength(tool.name) +
			Buffer.byteLength(tool.description) +
			Buffer.byteLength(JSON.stringify(tool.parameters));
		const mcpsSection = Buffer.byteLength(main.sections.find((section) => section.name === "mcps")?.text ?? "");
		// The bundled Octocode skills' names and descriptions come verbatim from the sibling release, like server text.
		const siblingSkills = Buffer.byteLength(
			/<octocode_skills>[\s\S]*?<\/octocode_skills>/.exec(systemText(main))?.[0] ?? "",
		);
		const parts = {
			system: Buffer.byteLength(systemText(main)) - mcpsSection - siblingSkills,
			tools: main.tools.filter((tool) => !isMcpTool(tool.name)).reduce((sum, tool) => sum + declared(tool), 0),
			agents: fs.statSync(fileURLToPath(new URL("../../../../AGENTS.md", import.meta.url))).size,
		};
		const server = {
			skills: siblingSkills,
			instructions: mcpsSection,
			tools: main.tools.filter((tool) => isMcpTool(tool.name)).reduce((sum, tool) => sum + declared(tool), 0),
		};
		const own = parts.system + parts.tools + parts.agents;
		// Not vacuous: a capture that lost its sections, its native tools or its MCP servers would pass any ceiling.
		expect(parts.system).toBeGreaterThan(15_000);
		expect(parts.tools).toBeGreaterThan(15_000);
		expect(server.instructions).toBeGreaterThan(0);
		expect(server.skills).toBeGreaterThan(0);
		expect(server.tools).toBeGreaterThan(0);
		expect(
			own,
			`first-request prefix text Octocode owns grew to ${own} bytes (${JSON.stringify(parts)}; sibling text (bundled skills, MCP servers), not capped: ${JSON.stringify(server)}); if the growth is worth paying on every request, raise OWN_PREFIX_CEILING and say why`,
		).toBeLessThanOrEqual(OWN_PREFIX_CEILING);
	});
});
