import { EntityFields } from "../../src/octocode/backlog/model.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
	// Hermetic: a run inside a Octocode subagent inherits its identity, which changes the tools and the prompt.
	for (const key of ["OCTOCODE_SUBAGENT", "OCTOCODE_BROWSER_VISIBLE", "OCTOCODE_AGENT_COLLABORATE"])
		delete process.env[key];
});
afterEach(() => {
	process.env = saved;
});

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
async function promptSize(options: { subagent: boolean; exclude?: string[] }): Promise<Size> {
	if (options.subagent) process.env.OCTOCODE_SUBAGENT = "1";
	const fake = fakePi();
	Object.assign(fake.pi, { getSessionName: () => undefined });
	await octocode(fake.pi);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: !options.subagent });
	Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
	await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	const active = fake.pi.getActiveTools().filter((name) => !options.exclude?.includes(name));
	const sections: Record<string, string> = {};
	await fake.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt: "hi", systemPromptOptions: { sections, selectedTools: active } },
		ctx,
	);
	const perTool: Record<string, number> = {};
	let backlogEntities = 0;
	for (const tool of fake.pi.getAllTools().filter((candidate) => active.includes(candidate.name))) {
		const { description, parameters, promptGuidelines } = tool as {
			description: string;
			parameters: unknown;
			promptGuidelines?: string[];
		};
		if (tool.name === "backlog") {
			const full = parameters as { properties: Record<string, unknown> };
			const oldFields = Object.fromEntries(
				Object.entries(full.properties).filter(([key]) => !(key in EntityFields)),
			);
			backlogEntities =
				JSON.stringify(parameters).length - JSON.stringify({ ...full, properties: oldFields }).length;
		}
		perTool[tool.name] =
			description.length + JSON.stringify(parameters).length + (promptGuidelines ?? []).join("").length;
	}
	const prompt = (sections.octocode ?? "").length;
	return {
		backlogEntities,
		total: Object.values(perTool).reduce((sum, size) => sum + size, prompt),
		prompt,
		perTool,
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
const MAIN_CEILING = 20_300;
// Every specialist now keeps file for requested reports and scratch artifacts (+1,635 measured schema characters).
const SPECIALIST_CEILING = 13_900;

describe("prompt size", () => {
	it("main session", async () => {
		const size = await promptSize({ subagent: false });
		console.log(`main session: ${size.total} chars (prompt ${size.prompt}); ${JSON.stringify(size.perTool)}`);
		expect(size.prompt).toBeGreaterThan(0);
		// Browser schemas belong to the specialist and consume no main-session prompt space.
		expect(size.perTool.browser).toBeUndefined();
		expect(size.backlogEntities).toBeGreaterThan(0);
		expect(size.backlogEntities).toBeLessThan(BACKLOG_ENTITIES_CEILING);
		expect(
			size.total - size.backlogEntities,
			`main session without new entity fields measured ${size.total - size.backlogEntities}`,
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
			`specialist without new entity fields measured ${size.total - size.backlogEntities}`,
		).toBeLessThan(SPECIALIST_CEILING);
	});
});
