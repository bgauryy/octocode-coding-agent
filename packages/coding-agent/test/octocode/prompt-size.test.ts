import { EntityFields } from "@octocodeai/octocode-contracts/backlogs";
import { BACKLOG_ITEM_ENV } from "../../../common/src/env.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { reportContractSentences } from "../../src/octocode/instructions/report.ts";
import { loadProfiles, profileExcludes } from "../../src/octocode/subagents/profiles.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { SYSTEM_PROMPT_SECTIONS } from "../../src/core/system-prompt-spec.ts";

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
	/** The policy sections, joined. */
	policy: string;
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
		.filter(([name]) => POLICY_SECTIONS.has(name))
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
// 1_500 (2026-10-31, measured 1_451 main, 1_254 subagent; was 3_000 against 1_660 and 1_463): the entity fields lost the
// link and completion property inventories (their descriptions name them) and `type` no longer lists the old `task`.
// 2_250 (2026-11-04, measured 2_176 main, 2_104 subagent; B28, user-approved): the inventories return as closed, typed
// schemas (strict-eligible). With the shapes only in prose, nested completion calls were closed at the wrong depth and
// guessed path forms (archive errors 2026-11-03..04); the link target stays a plain string, other resources a flat field.
const BACKLOG_ENTITIES_CEILING = 2_250;
// Delegation guidance on parallel work, shared contracts, named skills and report acceptance (+~400 measured characters).
// Children save far more: their skill descriptions and the Octocode docs block are dropped (outside this fake host).
// 20_900 (B15, measured 20_701): commit 5630993 already measured 20_570; +37 for the bash read fallback that replaced the
// removed read tool (`rg`, `fd`, `sed -n`), +94 for the browser profile description in the `Use when…; returns…` shape
// the other profiles use (the main session lists profile descriptions). Capability text added by B15 (Octocode deferred
// tool names, MCP server index, context notices) is not in this fake host: it is measured with the real assembled prompt.
// 21_400 (measured 21_163 after trimming the new descriptions): +193 file for line+sha anchored edits, +153 bash for the
// opt-in verification receipt (`verify`), +268 agent for bash-write reservations in coordinate and the subagent stop and
// overlap contract. All three were requested features; their descriptions were shortened.
// 22_000 (measured 21_808): +~650 user-requested editing and protocol policy: repository conventions, clean-code and
// parallel/script rules, one worked example, a task-contract brief, and BLUF, 5W2H and SBAR defined once in
// Communication at the time (role files name them instead of restating their slots; the policy now defines only the
// result, finding and SBAR formats, so BLUF and 5W2H no longer exist there).
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
// 43_000 (2026-10-29, measured 42_794 without entity fields; policy block 7_184, from 7_935): cuts to what repeated elsewhere. The policy no longer repeats
// seven tool mechanics (polling, references, model choice, headless, the contract file and locks, message fields,
// closing backlog items), the report contract (now once, in the child's task), or the skill-loading rule (the skills
// section), and its three universal templates became conditions. The agent `isolate` text names `refs/octocode/<id>`.
// 43_200 (2026-10-30, measured 43_122 without entity fields; policy 7_267): the user-requested `ollama` tool (+1_152) and
// the reorientation policy line (+160) land against -1_552 of declaration cuts: string unions declare `enum` instead of
// `anyOf` literals (debug, ollama, bash, models), the agent envelope states `reason` once at its root instead of in every
// branch and drops the "<mode> input" labels, `launch`/`resultSchema` are plain objects, and the debug, askUser,
// external, web, file, bash, memory, message and task descriptions lost restated mechanics. The graph CLI contracts
// (12_620) are the sibling native package's and were not changed.
// 43_400 (2026-10-30, measured 43_370 without entity fields): the user-requested bash output budget replaces the
// `| tail -n 50` rule with a longer one (each result starts with exit, time and size; trimmed output is saved; the
// `maxOutputTokens` parameter), +248 net over the 43_122 measured above; the bash tool gained no other text.
// 42_800 (2026-10-30, measured 42_688 without entity fields): B256 trims, lossless graph schema inlining (graphQuery
// -466, graphBuild -346), shorter debug and browser text, and a per-change `file` reason that defaults to the call's.
// 43_300 (2026-10-30, measured 43_133 without entity fields; user-requested): +445 for the root-cause rule (trace the
// symptom to its origin, fix causes not symptoms) and the system-design rule (fix in the owning module, no hand-picked
// special cases or one-call-site patches); still below the 43_400 before the B256 trims.
// 43_500 (2026-10-30, measured 43_301 without entity fields; user-requested): +168 for the testing rule that prefers
// behavioral and end-to-end tests of public contracts and keeps unit tests for test-first reproduction.
// 43_800 (2026-10-30, measured 43_577 without entity fields; user-requested): +276 for the evidence rule (cite path:line,
// command, URI or URL; connect evidence; never invent names, paths, APIs or results), merged into the existing
// assumption-label line instead of repeated in each tool description.
// 43_800 kept (2026-10-31, measured 43_698; B275): +121 for the conflict fixes (Safety now defines cleanup versus deletion
// of existing content once; the cross-tree rule names the other tree's owner; the finding line admits a role's severity),
// partly offset by dropping the testing rule from read-only roles (not in this main measurement).
// 43_500 (2026-10-31, measured 43_352 without entity fields; Task J, B295): lossless text cuts (duplicated tool
// mechanics, restated rationale, merged reviewer lines), -580 from 43_932. Lowered, not raised: the earlier
// 43_800 ceiling was already exceeded by 132 when the cuts started.
// 43_900 (2026-10-31, measured 43_800 without entity fields after concurrent edits by others, 43_684 for S2 alone;
// user-requested task entity, S2 of B311): the `task` tool
// (1_167 with its reason property, dropping the unobservable `version` and keeping `move`) and the backlog guidelines'
// quick-work rule, against the entity-field cuts above. The 43_500 ceiling had about 1_200 of slack over the 42_288 measured
// before the task tool, so the tool costs about +1_400 measured and the ceiling rises by 300.
// 44_100 (2026-10-31, measured 43_992 without entity fields; B311 review fixes): the task tool is 1_202 after trimming
// (was 1_383 with the persistence and quick-work guidance and a `why` property; the call's own `reason` is no longer
// declared by the tool, so the registry adds it). The 43_900 ceiling is exceeded by 92 with the task tool alone, which the
// user-requested task entity added; the ceiling rises by that measured overage plus 108 of headroom.
// 34_300 (2026-10-31, measured 34_053 without entity fields; B338/B340/B343/B344): lowered to the measurement after
// the graph tools were deleted, native tool text was re-authored, `agent` lost its input envelope, the `models` tool
// (856) replaced its agent type, and the prompt sections moved to one registry.
// 32_000 (2026-11-02, measured 31_807 without entity fields; B452 prompt review): `debug` is opt-in and the `agent`
// tool declares `external` only when an outside agent is reachable, against the added status, referent and MCP lines.
// 33_300 (2026-11-03, measured 32_833 without entity fields; B472, user-requested): cost-aware model routing, the 5W2H
// brief, dependency-graph scheduling with RACI ownership, problem reduction, PDCA/OODA/5 Whys and the BLUF/SBAR formats
// (rendered main policy +1_357: work +478, delegation +751, communication +128), trimmed before measuring.
// 33_950 (2026-11-04, measured 33_830 without entity fields, 33_289 at the previous commit; B6, user-approved): the restored
// research rule (+541 in the policy: Octocode MCP first, `localFetch` for reads, fallback when a tool fails). Tool sizes
// are unchanged.
// 34_450 (2026-11-04, measured 34_363 without entity fields; user-approved): the `task`
// `paths` field and its delegation sentence, the batch limit and example in the localFetch and localSearch triggers, and
// the sensitive-task rule on the `model` field. The `mcps` block shrank by about 8,000 chars after the override refresh,
// which this count does not include.
// 37_400 (2026-11-04, measured 37_325; user-requested): titled sections in the work and delegation policy, active management
// of children, bringing the user in early, separating backlog work, answering a budget request, and the one-protocol
// communication section (+1,996 in the policy).
// 36_650 (2026-11-04, measured 36_553 without entity fields; user-approved): exact duplicates cut from tool text (the
// `model` fit-the-task sentence, the bash timeout restatement, archive's data-not-instructions sentence, the web
// cache note and "not both" clauses, the goal example, the models snippet), about 800 chars in all.
// 37_350 (2026-11-04, measured 37_251 without entity fields, 36_559 before; B47, user-requested): the orchestration flow
// line, hard limits and binding memories in each task, shared-resource owners, defect owners, the `Noticed` line and fresh
// review, and telling the user unasked (+692 net after trimming the delegation text it joined).
// 37_086 (2026-11-04, measured 36_986 without entity fields, 37_249 before; B47 prompt audit): the delegate-or-not tree and
// the stuck-child routing became Mermaid, the backlog bullets merged, and the agent tool's own message routing left
// communication (-263 in the policy).
// 39_600 (2026-11-05, measured 39_501 without entity fields; requested by the user): the B55 bash CLI guide (+2_305 in
// the bash description) and B59's `octocode` CLI line in the research section (+110 in the policy).
// 39_700 (2026-11-06, measured 39_660; B150): the same +96 `reason` rule as the specialist ceiling.
// 41_208 (2026-11-06, measured 41_168; B156, user-requested): the backlog `updates` batch field (+1_463) and its id/why
// text (+45); measured main 39_660 before, so the ceiling rises by the measured +1_508.
// 42_330 (2026-11-06, measured 42_289 without entity fields): B157 +about 820 and B29 +about 300 over the 41_168 of B156.
// B157 (close instead of delete): the shared `close` shape (about 330) at the top level with a short description (about
// 380) and in each `updates` entry (about 330), the description's close sentence, the "still needed?" guideline line,
// less the `remove` op text. B29: the `mcp` field of the agent tool (+302).
// 43_283 (2026-11-06, measured 43_257; B170): the timer tool's closed `until` list. With only the timer tool surface
// reverted, main measures 42_304, so the surface costs +953: the `until` schema's `file`, `item`, `agent` and `port`
// objects with short field descriptions, `check` as one question string beside a trigger, the description's close
// sentence and the snippet's longer clause. The slack over the measurement stays 26, as before.
// 43_607 (2026-11-07, measured 43_581, 43_278 before; B218/B219, user-requested): the agent tool's `tasks` and the
// backlog's `items` arrays (+153 and +150). Their entries are declared as plain objects and checked against the single
// call's schema in code, which cut them from about 700 when every entry field was spelled out; the steps array was
// dropped (3 calls saved in 283 transcripts). The slack stays 26.
const MAIN_CEILING = 43_607;
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
// 32_800 (2026-10-30, measured 32_781 without entity fields): the same bash output budget text (+248).
// 32_200 (2026-10-30, measured 32_055 without entity fields): the same B256 trims.
// 32_600 (2026-10-30, measured 32_500 without entity fields; user-requested): the same root-cause and system-design
// rules (+445).
// 32_800 (2026-10-30, measured 32_668 without entity fields; user-requested): the same testing rule (+168).
// 33_100 (2026-10-30, measured 32_944 without entity fields; user-requested): the same evidence rule (+276).
// 33_100 kept (2026-10-31, measured 33_080; B275): +136 for the same conflict fixes (Safety boundary, cleanup bounded by the
// assigned area, the status-word-first report line), net of -66 from the child backlog guideline no longer repeating the
// completion fields. Read-only roles drop the 390-character testing rule (the reviewer keeps a shorter review form in its role: 18_794 -> 18_508 measured).
// 32_900 (2026-10-31, measured 32_778 without entity fields; Task J, B295): the same cuts, -478 from 33_256 (33_100 was
// already exceeded by 156 when the cuts started).
// 32_800 (2026-10-31, measured 32_648 without entity fields; user-requested task entity, S2 of B311): lowered from 32_900
// to the measurement; the subagent `task` tool (1_060, no promote) replaces the 31_418 measured before it, which had 1_480
// of slack under 32_900.
// 33_200 (2026-10-31, measured 33_132 without entity fields; B311 review fixes): the subagent `task` tool is 1_202 (no
// promote). Without it the specialist measures 31_930, 512 above the 31_418 recorded before the task tool, from edits by
// other sessions to shared tools and policy (not the task entity); the tool's text was trimmed first and the ceiling now
// follows the measurement instead of the 32_800 it exceeded by 332.
// 23_400 (2026-10-31, measured 23_216 without entity fields; B338/B340/B343/B344): lowered to the measurement after the
// same graph-tool removal and tool-text, agent and section changes.
// 20_500 (2026-11-02, measured 20_265 without entity fields, now with a backlog item so the backlog tool is declared;
// B452): the child communication section and the report contract's resume sentence left, and `debug` is opt-in.
// 21_600 (2026-11-02, measured 21_356 without entity fields; B463, user-requested): decision-layer rules — intent and
// proving check, unknowns and wrong premises, package manager and error handling, retry side effects, final diff,
// run-mode approvals, untrusted command output, plus the round-2 review restorations (request limit, coverage).
// 22_200 (2026-11-03, measured 21_915 without entity fields; B472, user-requested): the same problem-reduction,
// PDCA/OODA and 5 Whys lines (work +478) and the child's outcome-first line (communication +81).
// 22_640 (2026-11-04, measured 22_515 without entity fields, 21_974 at the previous commit; B6, user-approved): the same
// +541 research rule; tool sizes are unchanged.
// 23_000 (2026-11-04, measured 22_926; user-requested): titled sections and how a child reaches its parent.
// 23_250 (2026-11-04, measured 23_155; B47, user-requested): whom a stuck child asks (a teammate or its parent), telling
// the parent at once about a severe problem, keeping a shared tree building and backing off a busy lock.
// 23_163 (2026-11-04, measured 23_063 without entity fields, 23_155 before; B47 prompt audit): the stuck-child routing is a
// Mermaid diagram and the main-only close-out rule left the child's work section (-92 in the policy).
// 25_680 (2026-11-05, measured 25_578 without entity fields; requested by the user): the same B55 bash CLI guide
// (+2_305) and B59 `octocode` CLI line (+110).
// 26_230 (2026-11-05, measured 26_127, 25_223 without it; B95, requested by the user): the `timer` tool every agent gets
// (+904), after the B102 audit cut the policy.
// 26_380 (2026-11-05, measured 26_277, +150 over B95's 26_127; requested by the user, B83/M23 and instruction lines from
// B108/B120): the one `Harnesses:` line naming every harness on or off (core/discovery/vendors/prompt.ts), which
// specialists also get, the skill-match rule, the task scratch-write limit and the timer's wait-until line. MCP declared
// mode adds nothing here: this specialist declares no MCP server.
// 26_480 (2026-11-06, measured 26_465; B150): the one-line rule that `reason` belongs to native tools and MCP tools take
// only their declared fields (+96 in the policy; the test host reaches MCP, so it renders), after the declared default
// made small models copy `reason` into 21 of 359 MCP calls.
// 27_988 (2026-11-06, measured 27_956; B156): the same +1_508 for the backlog batch update field.
// 28_715 (2026-11-06, measured 28_675): B157's close shape at the top level and in `updates` (+about 720 with the `remove`
// op text gone and the field descriptions of B29's `mcp` rule); a subagent gets no new guideline line.
// 29_668 (2026-11-06, measured 29_643; B170): the same +953 timer tool surface (specialist 28_690 without it), which every
// agent declares; the slack over the measurement stays 25.
const SPECIALIST_CEILING = 29_668;

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
		expect(named.total - without.total).toBeGreaterThan(3_000);
		// The main session declares it whatever the environment says.
		expect((await promptSize({ subagent: false })).perTool.backlog).toBeGreaterThan(0);
	});

	it.each(["implementer", "reviewer"])("%s keeps its working tools", async (name) => {
		const profile = loadProfiles(tmp(), tmp(), false, {}).get(name)!;
		const exclude = profileExcludes(profile.excludeTools);
		const scoped = await promptSize({ subagent: true, readOnly: profile.readOnly, exclude });
		console.log(`${name}: ${scoped.total} chars`);
		for (const tool of ["file", "bash", "agent", "archive", "skill"]) expect(scoped.perTool[tool]).toBeGreaterThan(0);
	});

	it("states the report contract in the child's task only, never in the policy sections", async () => {
		const sentences = reportContractSentences();
		expect(sentences.length).toBeGreaterThan(3);
		for (const subagent of [false, true]) {
			const { policy } = await promptSize({ subagent });
			for (const sentence of sentences) expect(policy, `policy (subagent=${subagent})`).not.toContain(sentence);
			expect(policy).not.toContain("Start it with the outcome word");
		}
	});
});
