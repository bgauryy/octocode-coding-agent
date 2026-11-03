import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENTS, captureAll, type AgentContext } from "./agent-context/capture.ts";
import { isMcpTool } from "./agent-context/analyze.ts";
import { renderIndex, renderMessages, renderSystem, renderTools, systemText } from "./agent-context/render.ts";

/**
 * The full context each agent receives with its first model request, captured from real sessions on a scripted model:
 * the main session as the user starts it and every kind of subagent as `subagents/tool.ts` starts it. The files under
 * `instructions/rendered/` are snapshots of it, so this test fails while they are stale; `yarn run generate:prompts`
 * rewrites them (`vitest -u`). The checks below say what each agent's context must hold.
 */
const RENDERED = fileURLToPath(new URL("../../src/octocode/instructions/rendered/", import.meta.url));
const FILES = ["system.md", "tools.md", "messages.md"] as const;

const POLICY = [
	"octocode_work",
	"octocode_research",
	"octocode_delegation",
	"octocode_safety",
	"octocode_communication",
];
const BASE = ["preamble", "tools", "rules", "project_context", "cwd", "environment"];

const expectedFiles = (): string[] => [
	"README.md",
	...AGENTS.flatMap((agent) => FILES.map((file) => `${agent.name}/${file}`)),
];

const listed = (directory: string, prefix = ""): string[] =>
	fs.existsSync(directory)
		? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
				const name = `${prefix}${entry.name}`;
				return entry.isDirectory() ? listed(path.join(directory, entry.name), `${name}/`) : [name];
			})
		: [];

/** Whether vitest is rewriting snapshots (`-u`): a missing file is then expected, not a failure. */
const updating = (): boolean =>
	(expect.getState() as unknown as { snapshotState?: { _updateSnapshot?: string } }).snapshotState?._updateSnapshot ===
	"all";

let contexts: AgentContext[] = [];
/** What `rendered/` held when the run began (vitest writes a snapshot file only when the test file ends). */
let before: string[] = [];

beforeAll(async () => {
	before = listed(RENDERED);
	contexts = await captureAll();
}, 600_000);

// Declared first so it runs first: with -u a file no agent produces any more (a removed role, an old layout) goes with
// the rewrite; otherwise a stale or missing file fails the run.
it("rendered/ holds exactly the files the agents produce", () => {
	const wanted = expectedFiles();
	if (updating())
		for (const stale of before.filter((file) => !wanted.includes(file))) {
			fs.rmSync(path.join(RENDERED, stale));
			const folder = path.dirname(path.join(RENDERED, stale));
			if (path.resolve(folder) !== path.resolve(RENDERED) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
		}
	else {
		expect(
			before.filter((file) => !wanted.includes(file)),
			"stale files in rendered/",
		).toEqual([]);
		// A missing file is out of date, not new: vitest would otherwise write it silently.
		expect(
			wanted.filter((file) => !before.includes(file)),
			"files missing from rendered/",
		).toEqual([]);
	}
});

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
			expect(names).toContain("octocode_lean");
			for (const policy of POLICY) expect(names, `the full policy ${policy} in a lean child`).not.toContain(policy);
		} else if (["researcher", "reviewer", "browser"].includes(agent.role ?? "")) {
			// A read-only child's compact core (`policy/readonly.md`) replaces the work, delegation and safety sections.
			const core = POLICY.filter((name) => name !== "octocode_delegation" && name !== "octocode_safety");
			expect(names).toEqual(expect.arrayContaining(core));
			expect(names).not.toContain("octocode_delegation");
			expect(names).not.toContain("octocode_safety");
		} else {
			expect(names).toEqual(expect.arrayContaining(POLICY));
			expect(names).not.toContain("octocode_lean");
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
		expect(messages[0].text).toContain("## You");
		expect(messages[0].text).toContain("## Report");
		expect(messages[0].text).toContain("child-example");
	});

	it("matches its snapshot (run `yarn run generate:prompts` after changing a prompt source)", async () => {
		const files = {
			"system.md": renderSystem(context()),
			"tools.md": renderTools(context()),
			"messages.md": renderMessages(context()),
		};
		for (const [file, text] of Object.entries(files)) {
			expect(text, `${agent.name}/${file}`).not.toMatch(/\/(?:Users|home|private|var)\//);
			expect(text, `${agent.name}/${file}`).not.toMatch(/^Date: \d{4}-/m);
			await expect(text).toMatchFileSnapshot(path.join(RENDERED, agent.name, file));
		}
	});
});

describe("rendered index", () => {
	it("lists every agent and matches its snapshot", async () => {
		const index = renderIndex();
		for (const agent of AGENTS) expect(index).toContain(`](${agent.name}/system.md)`);
		await expect(index).toMatchFileSnapshot(path.join(RENDERED, "README.md"));
	});
});
