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
 * Each ceiling sits just above the latest measurement. When the prompt shrinks, lower it to match; raise one only for an
 * intended change, with a reason a reviewer can weigh against paying these characters on every request.
 */
/** Schema characters of the backlog's typed entity fields (links, completion, hierarchy): measured 2_176 main, 2_104 child. */
const BACKLOG_ENTITIES_CEILING = 2_250;
/** The main session's policy sections and tool surfaces without the entity fields: measured 39_429. */
const MAIN_CEILING = 39_455;
/** A specialist with the shared file and communication tools, without the entity fields: measured 24_839. */
const SPECIALIST_CEILING = 24_864;

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
