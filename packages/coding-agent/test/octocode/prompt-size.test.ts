import { EntityFields } from "@octocodeai/octocode-contracts/backlogs";
import { BACKLOG_ITEM_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { loadProfiles, profileExcludes } from "../../src/octocode/subagents/profiles.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { SYSTEM_PROMPT_SECTIONS } from "../../src/core/system-prompt-spec.ts";
import { captureAll, type AgentContext } from "./agent-context/capture.ts";
import { isMcpTool } from "./agent-context/analyze.ts";
import { systemText } from "./agent-context/render.ts";

// Measured as shipped: the research CLI resolves and agent shells run it, whatever this host has.
vi.mock("../../src/octocode/cli/shim.ts", async (original) => ({
	...(await original<object>()),
	octocodeCliAvailable: () => true,
}));

const POLICY_SECTIONS = new Set(
	SYSTEM_PROMPT_SECTIONS.filter((section) => section.group === "policy").map(({ name }) => name),
);

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
	// Hermetic: a run inside an Octocode subagent inherits its identity, which changes the tools and the prompt.
	for (const key of ["OCTOCODE_SUBAGENT", "OCTOCODE_BROWSER_VISIBLE", "OCTOCODE_READ_ONLY"]) delete process.env[key];
});
afterEach(() => {
	process.env = saved;
});

// The tools octocode-mcp declares. The fake host registers none, but their names select the research-workflow lines
// (`octocodeWorkflows`) and the "Outside" wording, so the measured prompt carries the same research policy as a real session.
const OCTOCODE_TOOLS = [
	"localSearch",
	"localFetch",
	"structureSearch",
	"astSearch",
	"lspSearch",
	"ghSearchRepo",
	"ghSearchCode",
	"ghStructure",
	"ghGetFileContent",
	"ghSearchHistory",
	"ghGetHistoryItem",
	"artifactSearch",
].map((name) => `mcp__octocode__${name}`);

interface Size {
	backlogEntities: number;
	total: number;
	prompt: number;
	perTool: Record<string, number>;
}

/**
 * Extension-owned descriptions, JSON schemas, prompt guidelines and the `octocode` section. This fake host excludes
 * Octocode's base prompt/tools, MCP, skill metadata, repository instructions and snippets. e2e.test.ts also budgets the real
 * default Octocode + MCP prefix. `exclude` mirrors a subagent profile's `excludeTools`.
 */
async function promptSize(options: {
	subagent: boolean;
	exclude?: string[];
	readOnly?: boolean;
	/** The backlog item a child's task names: without one a child does not declare `backlog`. */
	item?: string;
}): Promise<Size> {
	delete process.env[BACKLOG_ITEM_ENV];
	delete process.env.OCTOCODE_SUBAGENT;
	if (options.item) process.env[BACKLOG_ITEM_ENV] = options.item;
	if (options.subagent) process.env.OCTOCODE_SUBAGENT = "1";
	if (options.readOnly) process.env.OCTOCODE_READ_ONLY = "1";
	// Every tool declared in full, as once used in this folder: the deferred declaration (`mcpExposure: "recent"`) is smaller.
	const fake = fakeHost({ mcpExposure: "direct" });
	Object.assign(fake.api.session, { getName: () => undefined });
	await octocode(fake.api);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: !options.subagent });
	Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
	await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	const active = fake.api.tools.getActive().filter((name) => !options.exclude?.includes(name));
	const sections: Record<string, string> = {};
	await fake.fire(
		"before_agent_start",
		{
			type: "before_agent_start",
			prompt: "hi",
			systemPromptOptions: { sections, baseSections: sections, selectedTools: [...active, ...OCTOCODE_TOOLS] },
		},
		ctx,
	);
	const perTool: Record<string, number> = {};
	let backlogEntities = 0;
	for (const tool of fake.api.tools.getAll().filter((candidate) => active.includes(candidate.name))) {
		const { description, parameters, promptGuidelines } = tool as {
			description: string;
			parameters: unknown;
			promptGuidelines?: string[];
		};
		// The entity fields live in two tools since the split: `completion` in `backlog`, and `type`, `parentId` and
		// `dependsOn` inside an `items` entry of `backlogPlan`.
		if (tool.name === "backlog" || tool.name === "backlogPlan") {
			type Shape = { properties: Record<string, unknown> };
			const full = parameters as Shape & { properties: { items?: { items: Shape } } };
			const holder = tool.name === "backlog" ? full : full.properties.items!.items;
			const without = Object.fromEntries(Object.entries(holder.properties).filter(([key]) => !(key in EntityFields)));
			backlogEntities += JSON.stringify(holder).length - JSON.stringify({ ...holder, properties: without }).length;
		}
		perTool[tool.name] =
			description.length + JSON.stringify(parameters).length + (promptGuidelines ?? []).join("").length;
	}
	const policy = Object.entries(sections)
		.filter(([name]) => POLICY_SECTIONS.has(name))
		.map(([, text]) => text)
		.join("\n\n");
	const prompt = policy.length;
	return {
		backlogEntities,
		total: Object.values(perTool).reduce((sum, size) => sum + size, prompt),
		prompt,
		perTool,
	};
}

/*
 * Each ceiling sits just above the latest measurement. When the prompt shrinks, lower it to match; raise one only for an
 * intended change, with a reason a reviewer can weigh against paying these characters on every request.
 */
/**
 * Schema characters of the backlog tools' typed entity fields (completion in `backlog`; type, parent, dependencies and
 * links in a `backlogPlan` entry, and `version` on both): measured 1_669 main. One tool carried them all at 2_176
 * before the split.
 */
const BACKLOG_ENTITIES_CEILING = 1_750;
/**
 * Main policy and tool surfaces, excluding entity fields; tightened after instruction and description compression.
 * Raised from 36_950 for the user-requested rules: self versus delegate, worktree children beside other sessions, teams,
 * tmux use and grooming the backlog after a close (measured 37_373). Then 37_475 for the coordinate guideline that has every
 * agent check `coordinate` `list` before merges and repository-wide actions too (measured 37_448). Lowered to 36_800 (measured 36_410, 1.1% over) after the `agent` task-field descriptions were shortened. Lowered to 33_500
 * (measured 33_129, 1.1% over) after the efficiency pass that folded duplicated policy lines into the MCP block and tools.
 * Lowered to 32_700 (measured 32_333, 1.1% over) after the concise rewording of every native tool's text. Raised to
 * 33_200 (measured 32_844) for the rules the user asked for: state the next move every reply, map the blast radius,
 * visuals over prose, ask only when it changes the result, each option with its trade-off (+511).
 */
const MAIN_CEILING = 33_200;
/**
 * A specialist with the shared file and communication tools, excluding entity fields. It declares
 * `backlog` alone (five work operations), never `backlogPlan`. Raised from 21_050 for the rules that make every specialist
 * release the processes, timers and servers it starts and spend context on the next decision (measured 21_371).
 * Raised from 21_400 for the user-requested tmux rule: when to use a private tmux server and how to drive it safely
 * (measured 21_651). Then 21_755 for the same coordinate guideline as the main ceiling (measured 21_726). Then 22_000
 * (user-approved) for the user's coding rules: modular code for parallel work, clean architecture and code, strict lint,
 * scripts that condense output, and an item done only when its tasks are done and its resources released (measured 21_962).
 * Then 22_450 (user-approved; measured 22_373): the user's testing rule (edge cases, the real path, outcomes over
 * internals), `wait`'s cron fields (+207) and `bash`'s `sandbox` parameter (+155), less the child ask line that now
 * defers to the escalation rule (-136). Lowered to 22_200 (measured 21_951) after the concise rewording of every native
 * tool's text.
 */
const SPECIALIST_CEILING = 22_200;

/**
 * Measured 19,346 (MCP 11,750 + skills 7,596); 0.8% over. Raised from 19,500 (user-approved) for the user-requested
 * research, classify and maintenance skills, with octocode-research hidden on this host (measured 20,103).
 */
// Lowered to 19_000 (measured 18_686: MCP 11,239 + skills 7,447) after the concise skill descriptions and tool text.
const MCP_SKILLS_MAIN = 19_000;
/**
 * Measured 12,904 at most (reviewer: MCP 11,750 + a 2-skill catalog 1,154; researcher 12,838); 3.8% over. Raised from 12,600
 * because the bundled octocode-mcp tool text grew from 10,724 to 11,750, which Octocode may not rewrite.
 */
// Lowered to 13_000 (measured 12_700: researcher MCP 11,239 + skills 1,461) after the same pass.
const MCP_SKILLS_FILTERED = 13_000;

describe("prompt size", () => {
	it("main session", async () => {
		const size = await promptSize({ subagent: false });
		console.log(
			`main session: ${size.total} chars (prompt ${size.prompt}, entities ${size.backlogEntities}); ${JSON.stringify(size.perTool)}`,
		);
		expect(size.prompt).toBeGreaterThan(0);
		// Browsing defaults to the browser MCP server; the native `browser` tool is opt-in.
		expect(size.perTool.browser).toBeUndefined();
		expect(size.perTool.graphQuery).toBeUndefined();
		expect(size.perTool.graphBuild).toBeUndefined();
		expect(size.backlogEntities).toBeGreaterThan(0);
		expect(size.backlogEntities).toBeLessThan(BACKLOG_ENTITIES_CEILING);
		expect(
			size.total - size.backlogEntities,
			`main session without new entity fields measured ${size.total - size.backlogEntities} (policy ${size.prompt})`,
		).toBeLessThan(MAIN_CEILING);
	});

	it("specialist with shared file and communication tools", async () => {
		const size = await promptSize({ subagent: true, exclude: ["browser"], item: "B1" });
		console.log(
			`specialist: ${size.total} chars (prompt ${size.prompt}, entities ${size.backlogEntities}); ${JSON.stringify(size.perTool)}`,
		);
		expect(size.prompt).toBeGreaterThan(0);
		expect(size.perTool.file).toBeGreaterThan(0);
		expect(size.perTool.agent).toBeGreaterThan(0);
		expect(size.backlogEntities).toBeGreaterThan(0);
		expect(size.backlogEntities).toBeLessThan(BACKLOG_ENTITIES_CEILING);
		expect(
			size.total - size.backlogEntities,
			`specialist without new entity fields measured ${size.total - size.backlogEntities} (policy ${size.prompt})`,
		).toBeLessThan(SPECIALIST_CEILING);
	});

	it("a child declares backlog only when its task names an item", async () => {
		const without = await promptSize({ subagent: true, exclude: ["browser"] });
		const named = await promptSize({ subagent: true, exclude: ["browser"], item: "B1" });
		expect(without.perTool.backlog).toBeUndefined();
		expect(named.perTool.backlog).toBeGreaterThan(0);
		// What the item adds is the work tool alone; planning stays with the coordinator. The ceiling is a budget.
		expect(named.total - without.total).toBeGreaterThan(0);
		expect(named.total - without.total).toBeLessThan(1_900);
		expect(named.perTool.backlogPlan).toBeUndefined();
		expect(without.perTool.backlogPlan).toBeUndefined();
		// The main session declares it whatever the environment says.
		const main = await promptSize({ subagent: false });
		expect(main.perTool.backlog).toBeGreaterThan(0);
		expect(main.perTool.backlogPlan).toBeGreaterThan(0);
	});

	it.each(["implementer", "reviewer"])("%s keeps its working tools", async (name) => {
		const profile = loadProfiles(tmp(), tmp(), false, {}).get(name)!;
		const exclude = profileExcludes(profile.excludeTools);
		const scoped = await promptSize({ subagent: true, readOnly: profile.readOnly, exclude });
		console.log(`${name}: ${scoped.total} chars`);
		for (const tool of ["file", "bash", "agent", "archive", "memory", "skill"])
			expect(scoped.perTool[tool]).toBeGreaterThan(0);
	});
});

/*
 * The shipped heads, captured from real sessions on a scripted model (the same capture `generate:prompts` writes). Server
 * text is the sibling's, so this caps what a role pays for it on every request instead of trimming it.
 */
describe("declared MCP tools and skills catalog", () => {
	let contexts: AgentContext[] = [];
	beforeAll(async () => {
		contexts = await captureAll();
	}, 600_000);
	const named = (name: string) => contexts.find((context) => context.name === name)!;
	const bytes = (value: string) => Buffer.byteLength(value);
	/** Bytes of every declared MCP tool plus the system prompt's skill catalogs (own and bundled Octocode skills). */
	const mcpAndSkills = (context: AgentContext) => {
		const text = systemText(context);
		const catalogs = [...text.matchAll(/<(?:octocode_)?skills>[\s\S]*?<\/(?:octocode_)?skills>/g)].map(([block]) =>
			bytes(block),
		);
		const mcp = context.tools
			.filter((tool) => isMcpTool(tool.name))
			.reduce((sum, tool) => sum + bytes(tool.name + tool.description + JSON.stringify(tool.parameters)), 0);
		return { mcp, skills: catalogs.reduce((sum, size) => sum + size, 0) };
	};

	// Each ceiling is at most 5% over its measured reading; a role with a smaller catalog (B503) gets a lower one.
	const CEILINGS: Record<string, number> = {
		main: MCP_SKILLS_MAIN,
		general: MCP_SKILLS_MAIN,
		implementer: MCP_SKILLS_MAIN,
		researcher: MCP_SKILLS_FILTERED,
		reviewer: MCP_SKILLS_FILTERED,
	};
	it.each(Object.keys(CEILINGS))("%s stays under its MCP plus skills ceiling", (name) => {
		const { mcp, skills } = mcpAndSkills(named(name));
		console.log(`${name}: mcp ${mcp}, skills ${skills}`);
		expect(mcp).toBeGreaterThan(0);
		expect(skills).toBeGreaterThan(0);
		expect(mcp + skills, `MCP declarations ${mcp} + skills catalog ${skills}`).toBeLessThanOrEqual(CEILINGS[name]);
	});

	// Every role declares the shared core; what it does not use stays on demand (listed in `<tools>`, declared when used).
	const CORE = ["bash", "file", "mcp", "wait", "memory", "agent", "skill"];
	const ON_DEMAND = ["archive", "models", "browser", "graphQuery", "graphBuild"];
	it.each(["general", "implementer", "researcher", "reviewer"])(
		"%s declares its core tools and leaves the rest on demand",
		(name) => {
			const declared = named(name).tools.map((tool) => tool.name);
			for (const tool of CORE) expect(declared).toContain(tool);
			for (const tool of ON_DEMAND) expect(declared).not.toContain(tool);
			expect(declared.some(isMcpTool)).toBe(true);
		},
	);

	it("the main session adds the coordinator tools to the same core", () => {
		const declared = named("main").tools.map((tool) => tool.name);
		for (const tool of [...CORE, "backlog", "backlogPlan", "askUser"]) expect(declared).toContain(tool);
		for (const tool of ON_DEMAND) expect(declared).not.toContain(tool);
	});
});
