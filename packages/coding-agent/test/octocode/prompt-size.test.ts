import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { EntityFields } from "@octocodeai/octocode-contracts/backlogs";
import { BACKLOG_ITEM_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { loadProfiles, profileExcludes } from "../../src/octocode/subagents/profiles.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { SYSTEM_PROMPT_SECTIONS } from "../../src/core/system-prompt-spec.ts";
import { captureAll, captureMain, type AgentContext } from "./agent-context/capture.ts";
import { isMcpTool } from "./agent-context/analyze.ts";
import { type Layers, measureLayers, measureLoads, skillListingBytes } from "./agent-context/layers.ts";
import { systemText } from "./agent-context/render.ts";
import { MEMORY_SECTION } from "../../src/octocode/memory/file/section.ts";
import { MEMORY_FILE_MAX_BYTES, MEMORY_SECTIONS } from "../../src/octocode/memory/file/format.ts";
import { ensureMemoryDir } from "../../src/octocode/memory/file/paths.ts";
import { globalMemoryFile, workspaceMemoryFile } from "../../src/octocode/permission/memory-files.ts";

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
	/** The `memory` section (the MEMORY.md files): user data, measured apart from the policy and tools. */
	memory: number;
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
	/** The session's folder; default a new empty one. */
	cwd?: string;
}): Promise<Size> {
	delete process.env[BACKLOG_ITEM_ENV];
	delete process.env.OCTOCODE_SUBAGENT;
	if (options.item) process.env[BACKLOG_ITEM_ENV] = options.item;
	if (options.subagent) process.env.OCTOCODE_SUBAGENT = "1";
	if (options.readOnly) process.env.OCTOCODE_READ_ONLY = "1";
	// Every tool declared in full (`mcpExposure: "direct"`), as when the promotion snapshot names it: the thin declaration of
	// a tool it does not name (`usage`, the default) is smaller.
	const fake = fakeHost({ mcpExposure: "direct" });
	Object.assign(fake.api.session, { getName: () => undefined });
	await octocode(fake.api);
	const ctx = fakeCtx({ cwd: options.cwd ?? tmp(), hasUI: !options.subagent });
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
		memory: (sections[MEMORY_SECTION] ?? "").length,
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
 * visuals over prose, ask only when it changes the result, each option with its trade-off (+511). Raised to 33_284
 * (user request) for the `agent` task's `maxRequests` field, a per-task request cap below the profile's: the field costs
 * 126, of which 42 are paid by `agent` field text said twice (`resume`'s "needs task", `background`'s "Return at once",
 * `paths`' second "files or dir/"), so +84. Raised to 33_400 (measured 33_394; user request "do all" of the evidence RFC)
 * for source anchors: the memory tool's `sources` field (note provenance) and one archive sentence saying a search hit's
 * anchor is a `get` id (the anchor rides on `id`, no new archive field); about 7 of the rest came from other changes.
 */
const MAIN_CEILING = 33_400;
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

/*
 * MCP declarations plus skill catalogs on a fresh install, each at most 5% over its reading. Raised (from 19,000 and
 * 13,000) when thin declarations started carrying each field's allowed values, item bounds and required fields (MCP
 * 11,375 → 13,386 bytes), which they left out before; the octocode-mcp text is the sibling's and drifts with its builds.
 * Raised again (user decision) when every Octocode tool is declared by default (local, GitHub, package, security):
 * MCP 26,634 bytes.
 */
/** Main: MCP 26,634 + the whole catalog 7,874. */
const MCP_SKILLS_MAIN = 36_250;
/** A child without a role, and the implementer: MCP 26,634 + a 9-skill catalog 2,663. */
const MCP_SKILLS_GENERAL = 30_800;
/** The researcher (MCP 26,634 + skills 1,430) and the reviewer (skills 1,529). */
const MCP_SKILLS_FILTERED = 29_600;
/**
 * The browser child: the browser server's tools and the Octocode MCP tools (every specialist but lean gets the research
 * server), beside its local tools (bash, file, web, mcp, notify, agent, skill), and an empty skill catalog: measured
 * MCP 32,020 + skills 261.
 */
const MCP_SKILLS_BROWSER = 33_900;

/**
 * Bytes per layer of each agent's first request with no usage data (`measureLayers`), and `loads`: how many tools it
 * declares thin or leaves on demand, each a load on first use. Each ceiling is the measured value plus about 5%.
 */
const FIRST_REQUEST_CEILINGS: Record<string, Omit<Layers, "freellama"> & { loads: number }> = {
	main: {
		system: 14_350,
		mcpInstructions: 6_600,
		// skills: the octocode-code-review core skill (user request) measured 7,874. Octocode declares every tool:
		// mcpTools measured 26,634, total 70,228 (the same mcpTools in every child below except browser).
		skills: 8_300,
		nativeTools: 18_100,
		mcpTools: 28_000,
		total: 73_750,
		// The built-in browser server's 12 tools are on demand in main (one index line each): 14 + 19 = 33 measured.
		loads: 35,
	},
	general: {
		system: 11_650,
		mcpInstructions: 6_600,
		skills: 2_800,
		nativeTools: 9_950,
		mcpTools: 28_000,
		total: 56_800,
		loads: 20,
	},
	researcher: {
		// system measured 9,067 after the merged prompt rewrite; total 50,948.
		system: 9_550,
		mcpInstructions: 6_600,
		skills: 1_550,
		nativeTools: 9_950,
		mcpTools: 28_000,
		total: 53_500,
		loads: 20,
	},
	implementer: {
		system: 12_000,
		mcpInstructions: 6_600,
		skills: 2_800,
		nativeTools: 9_950,
		mcpTools: 28_000,
		total: 57_200,
		loads: 20,
	},
	reviewer: {
		// system measured 10,071; skills 1,529 (octocode-code-review, its working method); total 52,051.
		system: 10_600,
		mcpInstructions: 6_600,
		skills: 1_650,
		nativeTools: 9_950,
		mcpTools: 28_000,
		total: 54_700,
		loads: 20,
	},
	// mcpInstructions holds the browser server's and the Octocode MCP server's instructions (measured 8,901).
	browser: {
		system: 10_450,
		mcpInstructions: 9_350,
		// The browser server's and the Octocode MCP server's tools: mcpTools measured 32,020.
		skills: 300,
		nativeTools: 9_950,
		mcpTools: 33_650,
		// total measured 60,929.
		total: 64_000,
		loads: 39,
	},
	// Declares web since the lean role names it: nativeTools measured 7,034, total 11,300, loads 1 (web).
	lean: { system: 4_350, mcpInstructions: 0, skills: 0, nativeTools: 7_400, mcpTools: 0, total: 11_850, loads: 1 },
};

/**
 * The lean main session's first request on a fresh install (a 32k-window model, default settings), each layer about 5%
 * over its reading: system 4,717, mcpInstructions 4,855, nativeTools 17,350, mcpTools 26,634 (every Octocode tool, thin),
 * total 53,556 bytes, and 21 tools a first use loads. It lists no skills.
 */
const LEAN_MAIN_CEILINGS: Omit<Layers, "freellama"> & { loads: number } = {
	// system 4,851 since the browser server joined the main session's server list on demand (+101).
	system: 5_100,
	mcpInstructions: 6_850,
	skills: 0,
	nativeTools: 18_200,
	mcpTools: 28_000,
	total: 56_250,
	// 33 measured: the browser server's 12 on-demand tools join the 21.
	loads: 35,
};

/**
 * The `memory` section of a main session whose global and workspace MEMORY.md are both full: 30 non-blank lines each
 * (six headings, four lines under each), within the 4 KB file cap. It is the user's curated data, so it has its own
 * ceiling instead of moving MAIN_CEILING, and a full file neither hides nor excuses growth in the shipped text. Measured
 * 8,612: two files of 4,088 bytes, the header, and a label per file naming its path (a temporary folder's here).
 */
const MEMORY_SECTION_CEILING = 8_750;

/** A MEMORY.md at the line cap: every section with four lines, each as long as the 4 KB file cap allows. */
function fullMemoryFile(scope: string): string {
	const day = "2026-11-19";
	const text = (section: string, n: number, length: number) =>
		`${scope} ${section.toLowerCase()} rule ${n}; why it holds and how to apply it `.padEnd(length, "x");
	let length = 200;
	let file = "";
	for (; length > 20; length--) {
		file = `${MEMORY_SECTIONS.map((section) => [`## ${section}`, ...[1, 2, 3, 4].map((n) => `- ${text(section, n, length)} (agent ${day})`)].join("\n")).join("\n")}\n`;
		if (Buffer.byteLength(file) <= MEMORY_FILE_MAX_BYTES) break;
	}
	return file;
}

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

	it("the memory section of two full MEMORY.md files stays under its own ceiling, outside the main one", async () => {
		const cwd = fs.realpathSync(tmp());
		execFileSync("git", ["init", "-q", cwd], { stdio: "pipe" });
		const without = await promptSize({ subagent: false, cwd });
		expect(without.memory).toBe(0);
		for (const [ref, scope] of [
			[globalMemoryFile(), "global"],
			[workspaceMemoryFile(cwd), "workspace"],
		] as const) {
			const text = fullMemoryFile(scope);
			// The fixture sits at the cap: 30 non-blank lines, every one of them loadable.
			expect(text.split("\n").filter(Boolean)).toHaveLength(30);
			ensureMemoryDir(ref);
			fs.writeFileSync(ref.path, text);
		}
		const full = await promptSize({ subagent: false, cwd });
		// Every line of both files reached the prompt: none was left out for the cap.
		expect(full.memory).toBeGreaterThan(2 * (MEMORY_FILE_MAX_BYTES - 200));
		expect(full.memory).toBeLessThan(MEMORY_SECTION_CEILING);
		// The policy that MAIN_CEILING measures does not move with the user's notes.
		expect(full.prompt).toBe(without.prompt);
		expect(full.total).toBe(without.total);
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
 * The first request of every agent on a fresh install: captured from real sessions on a scripted model (the same capture
 * `generate:prompts` writes) with no usage data, so nothing is promoted: each MCP tool and each deferrable native tool
 * is declared thin or left on demand, and every one of them costs a load on first use. `served-first-request.test.ts`
 * measures a warm user's request, where the promoted tools are declared in full. Server text is the sibling's, so these
 * cap what a role pays for it on every request instead of trimming it.
 */
describe("first request with no usage data", () => {
	let contexts: AgentContext[] = [];
	beforeAll(async () => {
		contexts = await captureAll();
	}, 600_000);
	const named = (name: string) => contexts.find((context) => context.name === name)!;
	const bytes = (value: string) => Buffer.byteLength(value);
	/** Bytes of every declared MCP tool plus the skill listing in the `skill` tool's description. */
	const mcpAndSkills = (context: AgentContext) => {
		const mcp = context.tools
			.filter((tool) => isMcpTool(tool.name))
			.reduce((sum, tool) => sum + bytes(tool.name + tool.description + JSON.stringify(tool.parameters)), 0);
		return { mcp, skills: skillListingBytes(context) };
	};

	// Each ceiling is at most 5% over its measured reading; a role with a smaller catalog gets a lower one. A lean
	// child runs without MCP and lists no skills.
	const CEILINGS: Record<string, number> = {
		main: MCP_SKILLS_MAIN,
		general: MCP_SKILLS_GENERAL,
		implementer: MCP_SKILLS_GENERAL,
		researcher: MCP_SKILLS_FILTERED,
		reviewer: MCP_SKILLS_FILTERED,
		browser: MCP_SKILLS_BROWSER,
		lean: 0,
	};
	it.each(Object.keys(CEILINGS))("%s stays under its MCP plus skills ceiling", (name) => {
		const { mcp, skills } = mcpAndSkills(named(name));
		console.log(`${name}: mcp ${mcp}, skills ${skills}`);
		if (name !== "lean") expect(mcp).toBeGreaterThan(0);
		// The browser child's empty catalog leaves its `skill` tool out.
		if (name !== "lean" && name !== "browser") expect(skills).toBeGreaterThan(0);
		expect(mcp + skills, `MCP declarations ${mcp} + skills catalog ${skills}`).toBeLessThanOrEqual(CEILINGS[name]);
	});

	it.each(Object.keys(FIRST_REQUEST_CEILINGS))("%s stays under its per-layer ceilings and load count", (name) => {
		const layers = measureLayers(named(name));
		const loads = measureLoads(named(name));
		const { loads: maxLoads, ...ceilings } = FIRST_REQUEST_CEILINGS[name];
		for (const [layer, ceiling] of Object.entries(ceilings))
			expect(layers[layer as keyof typeof ceilings], `${name} ${layer}`).toBeLessThanOrEqual(ceiling);
		expect(
			loads.deferred + loads.onDemand,
			`${name} tools a first use loads: ${JSON.stringify(loads)}`,
		).toBeLessThanOrEqual(maxLoads);
	});

	it("counts what a fresh install defers: thin declarations and on-demand tools, with their full size", () => {
		const loads = measureLoads(named("main"));
		// Not vacuous: with no usage data the research tools are thin, and the GitHub tools wait for a first call.
		expect(loads.deferred).toBeGreaterThan(0);
		expect(loads.onDemand).toBeGreaterThan(0);
		expect(named("main").deferred?.map((tool) => tool.name)).toContain("mcp__octocode__localSearch");
		const thin = named("main").tools.find((tool) => tool.name === "mcp__octocode__localSearch")!;
		const full = named("main").deferred!.find((tool) => tool.name === "mcp__octocode__localSearch")!;
		expect(full.fullBytes).toBeGreaterThan(bytes(thin.name + thin.description + JSON.stringify(thin.parameters)));
		// Contract change: `web` became a core tool every role declares in full, so a lean child (bash, file, web and agent,
		// asserted below) defers no declaration; it used to defer only its thin `web`.
		expect(
			named("lean")
				.deferred?.filter((tool) => tool.state === "deferred")
				.map((tool) => tool.name),
		).toEqual([]);
	});

	it("lists each child only its role's skills, and none to the browser child", () => {
		const listing = (name: string) => named(name).tools.find((tool) => tool.name === "skill")?.description;
		expect(listing("browser")).toBeUndefined();
		expect(listing("researcher")).toContain("octocode-github-research");
		expect(listing("researcher")).not.toContain("octocode-test-plan");
		expect(listing("implementer")).toContain("octocode-test-plan");
		expect(systemText(named("researcher"))).not.toMatch(/<skills>|<available_skills>/);
	});

	// Every role declares the shared core; what it does not use stays on demand (listed in `<tools>`, declared when used).
	const CORE = ["bash", "file", "mcp", "notify", "agent", "skill"];
	const ON_DEMAND = ["archive", "models", "browser", "graphQuery", "graphBuild"];
	it.each(["general", "implementer", "researcher", "reviewer"])(
		"%s declares its core tools and leaves the rest on demand",
		(name) => {
			const declared = named(name).tools.map((tool) => tool.name);
			for (const tool of CORE) expect(declared).toContain(tool);
			for (const tool of ON_DEMAND) expect(declared).not.toContain(tool);
			expect(declared.some(isMcpTool)).toBe(true);
			// A child rarely reads memories: the tool stays callable, declared thin or on demand.
			const memory = named(name).deferred?.find((tool) => tool.name === "memory");
			expect(memory, `${name} memory`).toBeDefined();
		},
	);

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
		"ghCloneRepo",
		"artifactSearch",
		"securityCheck",
	].map((tool) => `mcp__octocode__${tool}`);
	it.each(["main", "general", "implementer", "researcher", "reviewer"])(
		"%s declares every Octocode MCP tool and the web tool, and no browser tool",
		(name) => {
			const declared = named(name).tools.map((tool) => tool.name);
			for (const tool of [...OCTOCODE_TOOLS, "web"]) expect(declared, name).toContain(tool);
			expect(
				declared.filter((tool) => tool.startsWith("mcp__browser__")),
				name,
			).toEqual([]);
		},
	);

	it("only the browser role declares browser tools, and the lean role declares exactly bash, file, web and agent", () => {
		const browser = named("browser").tools.map((tool) => tool.name);
		expect(browser.some((tool) => tool.startsWith("mcp__browser__"))).toBe(true);
		expect(browser).toContain("web");
		const lean = named("lean").tools.map((tool) => tool.name);
		expect([...lean].sort()).toEqual(["agent", "bash", "file", "web"]);
	});

	it("declares the coordinator's planning tool to no child", () => {
		for (const context of contexts.filter((each) => each.kind === "child"))
			expect(
				context.tools.map((tool) => tool.name),
				context.name,
			).not.toContain("backlogPlan");
	});

	it("the main session adds the coordinator tools to the same core", () => {
		const declared = named("main").tools.map((tool) => tool.name);
		for (const tool of [...CORE, "memory", "backlog", "backlogPlan", "askUser"]) expect(declared).toContain(tool);
		for (const tool of ON_DEMAND) expect(declared).not.toContain(tool);
	});
});

/**
 * A main session on a 32k-window model picks the lean main policy (`core/lean-main.ts`): the lean rules instead of
 * the work, delegation and communication sections, no skill list, and every open MCP tool declared thin whatever
 * `mcpExposure` says, so no MCP tool sends its full schema in the first request.
 */
describe("lean main session (32k window)", () => {
	let lean: AgentContext;
	let full: AgentContext;
	let fresh: AgentContext;
	beforeAll(async () => {
		// `direct` declares every open tool in full; only the lean choice defers them.
		lean = await captureMain({ mcpExposure: "direct" }, false, 32_768);
		full = await captureMain({ mcpExposure: "direct" });
		// A fresh install's lean main, with the default settings, for the ceilings.
		fresh = await captureMain(undefined, false, 32_768);
	}, 600_000);
	const mcpTools = (context: AgentContext) => context.tools.filter((tool) => isMcpTool(tool.name));
	const thin = (context: AgentContext) =>
		new Set((context.deferred ?? []).filter((tool) => tool.state === "deferred").map((tool) => tool.name));

	it("declares no MCP tool with its full schema, where a large window declares them in full", () => {
		expect(mcpTools(lean).length).toBeGreaterThan(0);
		for (const tool of mcpTools(lean)) expect(thin(lean), tool.name).toContain(tool.name);
		expect(mcpTools(full).some((tool) => !thin(full).has(tool.name))).toBe(true);
	});

	it("stays under the lean main ceilings on a fresh install", () => {
		const layers = measureLayers(fresh);
		const loads = measureLoads(fresh);
		const { loads: maxLoads, ...ceilings } = LEAN_MAIN_CEILINGS;
		for (const [layer, ceiling] of Object.entries(ceilings))
			expect(layers[layer as keyof typeof ceilings], `lean main ${layer}`).toBeLessThanOrEqual(ceiling);
		expect(loads.deferred + loads.onDemand, `lean main loads: ${JSON.stringify(loads)}`).toBeLessThanOrEqual(maxLoads);
	});
});
