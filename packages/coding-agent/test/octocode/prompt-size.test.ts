import { EntityFields } from "@octocodeai/octocode-contacts/backlogs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { reportContractSentences } from "../../src/octocode/instructions/report.ts";
import { loadProfiles, profileExcludes } from "../../src/octocode/subagents/profiles.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
	// Hermetic: a run inside a Octocode subagent inherits its identity, which changes the tools and the prompt.
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
	/** The `octocode_*` policy sections, joined. */
	policy: string;
}

/**
 * Extension-owned descriptions, JSON schemas, prompt guidelines and the `octocode` section. This fake host excludes
 * Octocode's base prompt/tools, MCP, skill metadata, repository instructions and snippets. e2e.test.ts also budgets the real
 * default Octocode + MCP prefix. `exclude` mirrors a subagent profile's `excludeTools`.
 */
async function promptSize(options: { subagent: boolean; exclude?: string[]; readOnly?: boolean }): Promise<Size> {
	if (options.subagent) process.env.OCTOCODE_SUBAGENT = "1";
	if (options.readOnly) process.env.OCTOCODE_READ_ONLY = "1";
	const fake = fakeHost();
	Object.assign(fake.api, { getSessionName: () => undefined });
	await octocode(fake.api);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: !options.subagent });
	Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
	await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	const active = fake.api.getActiveTools().filter((name) => !options.exclude?.includes(name));
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
	for (const tool of fake.api.getAllTools().filter((candidate) => active.includes(candidate.name))) {
		const { description, parameters, promptGuidelines } = tool as {
			description: string;
			parameters: unknown;
			promptGuidelines?: string[];
		};
		if (tool.name === "backlog") {
			const full = parameters as { properties: Record<string, unknown> };
			const oldFields = Object.fromEntries(Object.entries(full.properties).filter(([key]) => !(key in EntityFields)));
			backlogEntities = JSON.stringify(parameters).length - JSON.stringify({ ...full, properties: oldFields }).length;
		}
		perTool[tool.name] =
			description.length + JSON.stringify(parameters).length + (promptGuidelines ?? []).join("").length;
	}
	const policy = Object.entries(sections)
		.filter(([name]) => name.startsWith("octocode_"))
		.map(([, text]) => text)
		.join("\n\n");
	const prompt = policy.length;
	return {
		backlogEntities,
		total: Object.values(perTool).reduce((sum, size) => sum + size, prompt),
		prompt,
		perTool,
		policy,
	};
}

/*
 * Ceilings are about 5% above the size measured when they were set. When the prompt shrinks, lower them to match;
 * never raise one without a reason a reviewer can weigh against paying these characters on every request.
 */
// 17_900: +100 for the no-polling rule in the agent and bash descriptions. Without it an agent
// sleep-polled a background subagent for about 25 minutes.
// +1,100 for the user-requested main-session externalAgent contract: one adapter surface
// replaces vendor-specific tool descriptions; subagents still exclude it.
// +900 each for the user-requested `archive` tool (840 measured): one tool with a goal and a reason searches and reads
// every history the session may read, replacing the rg/localSearch recipe; subagents keep it (a core tool).
// +200 each for the user-requested bash output rule (148 with its newline): `| tail -n 50` keeps a build or test log from
// costing up to 50 KB per call, and `set -o pipefail;` keeps a failing command from reading as passing through the pipe.
// User-requested typed hierarchy, references and structured completion add schema text on every call.
// Budget that capability separately: retain the original ceilings for all other prompt content.
// This makes future growth in either the existing tools or the new entity contract fail independently.
const BACKLOG_ENTITIES_CEILING = 3_000;
// Delegation guidance on parallel work, shared contracts, named skills and report acceptance (+~400 measured characters).
// Children save far more: their skill descriptions and the Octocode docs block are dropped (outside this fake host).
// 20_900 (B15, measured 20_701): commit 5630993 already measured 20_570; +37 for the bash read fallback that replaced the
// removed read tool (`rg`, `fd`, `sed -n`), +94 for the browser profile description in the `Use when…; returns…` shape
// the other profiles use (the main session lists profile descriptions). Capability text added by B15 (Octocode deferred
// tool names, MCP server index, context notices) is not in this fake host: it is measured with the real assembled prompt.
// 21_400 (measured 21_163 after trimming the new descriptions): +193 file for line+sha anchored edits, +153 bash for the
// opt-in verification receipt (`verify`), +268 agent for bash-write reservations in coordinate and the subagent stop and
// overlap contract (agent lifecycle signals RFC). All three were requested features; their descriptions were shortened.
// 22_000 (measured 21_808): +~650 user-requested editing and protocol policy: repository conventions, clean-code and
// parallel/script rules, one worked example, a task-contract brief, and BLUF, 5W2H and SBAR defined once in
// Communication (role files now name them instead of restating their slots).
// 29_000 (measured 27_502 without entity fields): +5_333 for user-requested default browser/debug activation.
// Their schemas now cost 3_409 and 1_924 characters respectively in every main-session request.
// 31_000 (measured 30_600 without entity fields, with the real Octocode tool list): +1_631 over the 29_000 baseline.
// B89's skill line and `skill` tool and B90's required `reason` property on every tool schema took the old measurement
// to 29_131; the Octocode research-workflow lines and the wider "Outside" wording, now counted because this test passes
// the tool list, add 1_469.
// 29_200 (measured 27_798 without entity fields): browsing moved to the built-in browser MCP server, whose tools defer
// behind tool search, so the native `browser` schema (3_533) left the default request; the graph tools (about 12_000)
// are deferred the same way.
// 40_500 (2026-10-28, measured 40_226 without entity fields): deferred exposure and tool_search were removed, so the
// graph tools are declared in every request: graphBuild 2_964 + graphQuery 9_171 = 12_135 characters, cached with the
// tool declarations.
// 41_300 (2026-10-29, measured 41_002 without entity fields): user-requested debugger pause, exception stops and
// Node/TypeScript support through js-debug (the `pause` action, `tcp` and `exceptions` fields and their adapter line;
// debug schema 2_879, after trimming), plus 136 for B173's agent external/models fields.
// 42_600 (2026-10-29, measured 42_261 without entity fields): the graph tool contracts come from the sibling native CLI
// (graphQuery 9_764, graphBuild 2_852), and with them the previous commit already measured 40_978. On top of that commit:
// debug +872 (the debugger pause, exception and js-debug schema above), agent +258 (B173 external/models fields and the
// models `scope` parameter) and +153 in the assembled system prompt.
// 43_100 (2026-10-29, measured 42_985 without entity fields; user-approved): B205 message-by-reference, trimmed to
// +504 over the 42_481 baseline: the shared `msg#<N>`/`report:<agent-id>` policy line, the agent `task` cite text,
// scratch retention from OCTOCODE_CLEANUP_DAYS (+16), the message `forward` field and the external `refs` field.
// 43_600 (2026-10-29, measured 43_526 without entity fields; user-approved B213): the main-session `compact` tool (449
// with its reason property and prompt snippet); subagents do not get it, so the specialist ceiling is unchanged.
// 43_000 (2026-10-29, measured 42_794 without entity fields; policy block 7_184, from 7_935): RFC D7/S1 cuts. The policy no longer repeats
// seven tool mechanics (polling, references, model choice, headless, the contract file and locks, message fields,
// closing backlog items), the report contract (now once, in the child's task), or the skill-loading rule (the skills
// section), and its three universal templates became conditions. The agent `isolate` text names `refs/octocode/<id>`.
// 43_200 (2026-10-30, measured 43_122 without entity fields; policy 7_267): the user-requested `ollama` tool (+1_152) and
// the reorientation policy line (+160) land against -1_552 of declaration cuts: string unions declare `enum` instead of
// `anyOf` literals (debug, ollama, bash, models), the agent envelope states `reason` once at its root instead of in every
// branch and drops the "<mode> input" labels, `launch`/`resultSchema` are plain objects, and the debug, askUser,
// external, web, file, bash, memory, message and task descriptions lost restated mechanics. The graph CLI contracts
// (12_620) are the sibling native package's and were not changed.
const MAIN_CEILING = 43_200;
// Every specialist now keeps file for requested reports and scratch artifacts (+1,635 measured schema characters).
// 14_100 (B15, measured 13_931): +37 for the same bash read fallback.
// 14_600 (measured 14_356): the same file, bash and coordinate additions.
// 15_300 (measured 15_051): the same shared policy additions.
// 18_500 (measured 17_532 without entity fields): +1_924 for default debug activation.
// 20_700 (measured 20_363 without entity fields, with the real Octocode tool list): the same B89 and B90 growth
// (18_894 before the tool list) plus 1_469 for the research-workflow lines.
// 32_400 (2026-10-28, measured 32_154 without entity fields): the same 12_135 characters of declared graph tools.
// 32_800 (2026-10-29, measured 32_548 without entity fields): the same debugger pause, exception and js-debug schema.
// 33_800 (2026-10-29, measured 33_532 without entity fields): the same native-CLI graph contracts (the previous commit
// measured 32_660 with them) plus debug +872.
// 34_200 (2026-10-29, measured 34_075 without entity fields; user-approved): the same trimmed B205 additions (+305
// over the 33_770 baseline: the subagent reference line, scratch retention and the message `forward` field).
// 33_100 (2026-10-29, measured 32_910 without entity fields): the same S1 cuts; a child's report contract and its
// `blocked` semantics ride in its task, so the Subagent section lost its longest lines.
// 32_600 (2026-10-30, measured 32_519 without entity fields): the same declaration cuts (debug -357, agent -135,
// web -135, memory and skill text), with no subagent `ollama` tool to offset them.
const SPECIALIST_CEILING = 32_600;

describe("prompt size", () => {
	it("main session", async () => {
		const size = await promptSize({ subagent: false });
		console.log(`main session: ${size.total} chars (prompt ${size.prompt}); ${JSON.stringify(size.perTool)}`);
		expect(size.prompt).toBeGreaterThan(0);
		// Browsing defaults to the browser MCP server; the native `browser` tool is opt-in. The graph tools are declared.
		expect(size.perTool.browser).toBeUndefined();
		expect(size.perTool.graphQuery).toBeGreaterThan(0);
		expect(size.perTool.debug).toBeGreaterThan(0);
		expect(size.backlogEntities).toBeGreaterThan(0);
		expect(size.backlogEntities).toBeLessThan(BACKLOG_ENTITIES_CEILING);
		expect(
			size.total - size.backlogEntities,
			`main session without new entity fields measured ${size.total - size.backlogEntities} (policy ${size.prompt})`,
		).toBeLessThan(MAIN_CEILING);
	});

	it("specialist with shared file and communication tools", async () => {
		const size = await promptSize({ subagent: true, exclude: ["browser"] });
		console.log(`specialist: ${size.total} chars (prompt ${size.prompt}); ${JSON.stringify(size.perTool)}`);
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

	it.each(["implementer", "reviewer"])("%s keeps its working tools without graph schemas", async (name) => {
		const profile = loadProfiles(tmp(), tmp(), false, {}).get(name)!;
		const exclude = profileExcludes(profile.excludeTools);
		const baseline = await promptSize({
			subagent: true,
			readOnly: profile.readOnly,
			exclude: exclude.filter((tool) => !["graphBuild", "graphQuery"].includes(tool)),
		});
		const scoped = await promptSize({ subagent: true, readOnly: profile.readOnly, exclude });
		console.log(
			`${name}: ${scoped.total} chars; avoids ${baseline.total - scoped.total} (${baseline.perTool.graphBuild + baseline.perTool.graphQuery} graph declarations)`,
		);
		expect(scoped.perTool.graphBuild).toBeUndefined();
		expect(scoped.perTool.graphQuery).toBeUndefined();
		expect(scoped.total).toBeLessThan(baseline.total - 12_000);
		for (const tool of ["file", "bash", "agent", "archive", "skill"]) expect(scoped.perTool[tool]).toBeGreaterThan(0);
	});

	it("states the report contract in the child's task only, never in the policy sections", async () => {
		const sentences = reportContractSentences();
		expect(sentences.length).toBeGreaterThan(3);
		for (const subagent of [false, true]) {
			const { policy } = await promptSize({ subagent });
			for (const sentence of sentences) expect(policy, `policy (subagent=${subagent})`).not.toContain(sentence);
			expect(policy).not.toContain("Start it with one word");
		}
	});
});
