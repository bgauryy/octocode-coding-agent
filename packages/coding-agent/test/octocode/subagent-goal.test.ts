import { withoutSourceHeader } from "../../src/octocode/shared/fence.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { withIdentity } from "../../src/octocode/native/prompts/task.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { renderAgentCall } from "../../src/octocode/subagents/render.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { AGENT_NAMES } from "../../src/octocode/team/identity.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const GOAL = "audit auth token refresh";

beforeAll(() => {
	const root = tmp("octocode-agent-goal-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	process.env.OCTOCODE_AGENT_DB = path.join(root, "team", "team.sqlite");
	for (const key of [
		"OCTOCODE_SUBAGENT",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_AGENT_ROLE",
		"OCTOCODE_AGENT_GOAL",
		"OCTOCODE_PARENT_ID",
		"OCTOCODE_AGENT_SCRATCH",
		"OCTOCODE_TEAM_WORKSPACE",
		"OCTOCODE_MAX_SUBAGENTS",
	])
		delete process.env[key];
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});
afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

const profiles = new Map<string, AgentProfile>([
	["reviewer", { name: "reviewer", description: "reviews", prompt: "Review only." }],
]);

function setup() {
	const f = fakeHost();
	const team = new Team(f.api);
	registerAgentTool(f.api, { profiles: () => profiles, team, permission: fakePermission() });
	const cwd = tmp("octocode-agent-goal-cwd-");
	const ctx = fakeCtx({ cwd, hasUI: true });
	team.start(ctx);
	const agent = f.tools.get("agent");
	return {
		...f,
		team,
		agent,
		ctx,
		run: (params: Record<string, unknown>) => agent.execute("call-1", params, undefined, undefined, ctx),
	};
}
const reportOf = (text: string) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

describe("the agent tool's goal", () => {
	it("takes a goal without a schema size limit", () => {
		const { agent } = setup();
		const goal = agent.parameters.properties.goal;
		// Optional in the schema so `resume` can keep the child's goal; a new child without one is refused (next test).
		expect(agent.parameters.required).toEqual(["task"]);
		expect(goal).toEqual({ type: "string", description: expect.any(String) });
		expect(agent.parameters.properties.task).not.toHaveProperty("minLength");
	});

	it("refuses a missing or empty goal before anything starts, accepts an over-long one", async () => {
		const s = setup();
		await expect(s.run({ task: "report" })).rejects.toThrow(/goal/i);
		await expect(s.run({ task: "report", goal: "  " })).rejects.toThrow(/A goal is required/);
		// O6b (design B36): the main session is a member from its start; no child may be.
		expect(s.team.members().filter((member) => member.parentId !== undefined || member.role !== "main")).toEqual([]);
		const long = "audit the auth token refresh flow end to end across every service we run in production";
		const result = await s.run({ task: "report", goal: long });
		expect(reportOf(result.content[0].text as string).goal).toBe(long);
	});

	it("names the child from the closed list and hands it name, role, goal and parent in env and task", async () => {
		const s = setup();
		const result = await s.run({ task: "report back", goal: `  ${GOAL}\n`, profile: "reviewer" });
		const facts = reportOf(result.content[0].text as string);
		expect(AGENT_NAMES).toContain(facts.id);
		expect(facts).toMatchObject({ role: "reviewer", goal: GOAL, parent: s.team.id });
		expect(result.details).toMatchObject({ id: facts.id, profile: "reviewer", goal: GOAL });
		for (const value of [facts.id, "reviewer", GOAL, s.team.id]) expect(facts.task).toContain(value);
	});

	it("tells the child why it was started: the reason of the call that started it", async () => {
		const s = setup();
		const result = await s.run({ task: "report", goal: GOAL, reason: "The refresh  flow\nchanged in #42" });
		const facts = reportOf(result.content[0].text as string);
		expect(facts.task).toContain("The refresh flow changed in #42");
		expect(facts.task).toContain(GOAL);
		const bare = reportOf((await s.run({ task: "report", goal: GOAL })).content[0].text as string);
		expect(bare.task).not.toContain("The refresh flow changed in #42");
	});

	it("gives parallel children different names", async () => {
		const s = setup();
		const ids = await Promise.all(
			[1, 2, 3].map(async (n) => reportOf((await s.run({ task: "report", goal: `job ${n}` })).content[0].text).id),
		);
		expect(new Set(ids).size).toBe(3);
	});

	it("shows name in the background start, name and goal in its report and the renderers", async () => {
		const s = setup();
		const started = await s.run({
			task: "report from the background",
			goal: GOAL,
			profile: "reviewer",
			background: true,
		});
		const id = started.details.id as string;
		expect(started.content[0].text).toContain(`Started ${id} (reviewer) in the background`);
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0), { timeout: 10_000 });
		expect(withoutSourceHeader(String(s.sent[0].message.content))).toMatch(
			new RegExp(`^Background subagent ${id} \\(reviewer: ${GOAL}\\) finished \\(`),
		);
		expect(s.sent[0].message.details).toMatchObject({ id, goal: GOAL, profile: "reviewer" });
		const shown = rendered(s.renderers.get("octocode-agent-result")(s.sent[0].message, { expanded: false }, theme));
		expect(shown).toContain(`Agent(${id} · ${GOAL})`);
		expect(shown.split("\n")[0]).not.toContain("reviewer");
		expect(shown).toContain("Done · 1 tool call");
	});

	it("names a live agent with a similar goal in the launch result, and nothing for an unrelated goal", async () => {
		const s = setup();
		const live = {
			id: "snappy-mantle",
			role: "researcher",
			pid: 1,
			status: "working" as const,
			goal: "audit agent loop + context engineering",
			joinedAt: 0,
			updatedAt: Date.now(),
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
			pending: 0,
		};
		const real = s.team.members.bind(s.team);
		vi.spyOn(s.team, "members").mockImplementation(() => [...real(), live]);
		const similar = await s.run({ task: "report", goal: "context engineering audit, RFC and fixes", background: true });
		expect(similar.content[0].text).toContain(
			"Similar goal already running: snappy-mantle (audit agent loop + context engineering).",
		);
		const unrelated = await s.run({ task: "report", goal: "fix flaky tui test", background: true });
		expect(unrelated.content[0].text).not.toContain("Similar goal");
		await vi.waitFor(() => expect(s.sent.length).toBe(2), { timeout: 10_000 });
	});

	it("draws the call as the goal, without the role, and the running result with the name", async () => {
		expect(rendered(renderAgentCall({ task: "x", goal: GOAL, profile: "reviewer" }, theme, {}))).toBe(
			`⏺ Agent(${GOAL})`,
		);
		expect(rendered(renderAgentCall({ goal: "a\u001b[2Jb" }, theme, {}))).not.toContain("\u001b");
		const s = setup();
		const partial = rendered(
			s.agent.renderResult(
				{
					content: [{ type: "text", text: "working" }],
					details: {
						id: "inky-kraken",
						profile: "reviewer",
						goal: GOAL,
						toolCalls: 1,
						activity: [],
						input: 0,
						output: 0,
						startedAt: 0,
						status: "running",
					},
				},
				{ isPartial: true, expanded: false },
				theme,
				{ isError: false },
			),
		);
		expect(partial).toContain(`inky-kraken · 1 tool call`);
	});
});

describe("child identity", () => {
	it("passes role and goal to the child process", () => {
		const env = subagentProcessEnv(
			undefined,
			{ OCTOCODE_AGENT_GOAL: "stale", OCTOCODE_AGENT_ROLE: "stale" },
			{ id: "inky-kraken", role: "reviewer", goal: GOAL, parentId: "salty-squid" },
		);
		expect(env).toMatchObject({
			OCTOCODE_AGENT_ID: "inky-kraken",
			OCTOCODE_AGENT_ROLE: "reviewer",
			OCTOCODE_AGENT_GOAL: GOAL,
			OCTOCODE_PARENT_ID: "salty-squid",
		});
		const bare = subagentProcessEnv(undefined, { OCTOCODE_AGENT_GOAL: "stale", OCTOCODE_AGENT_ROLE: "stale" });
		expect(bare.OCTOCODE_AGENT_GOAL).toBeUndefined();
		expect(bare.OCTOCODE_AGENT_ROLE).toBeUndefined();
	});

	it("keeps the why's own ending punctuation", () => {
		const text = withIdentity("do it", { id: "inky-kraken", goal: GOAL, why: "Is the cache stale?" });
		expect(text).toContain("Is the cache stale?");
	});

	it("tells the child its own name, role, goal, parent and scratch folder", () => {
		const text = withIdentity("do it", {
			id: "inky-kraken",
			role: "reviewer",
			goal: GOAL,
			parentId: "salty-squid",
			scratch: "/tmp/s",
		});
		for (const value of ["do it", "inky-kraken", "reviewer", GOAL, "salty-squid", "/tmp/s"])
			expect(text).toContain(value);
	});

	it("adds one line naming the parent's archive library only when it is given", () => {
		const identity = { id: "inky-kraken", role: "reviewer", parentId: "salty-squid", scratch: "/tmp/s" };
		const base = withIdentity("do it", identity);
		expect(withIdentity("do it", identity, undefined)).toBe(base);
		const library = "/home/u/.octocode/agent/sessions/s/archive/LIBRARY.md";
		expect(base).not.toContain(path.dirname(library));
		expect(withIdentity("do it", identity, { library })).toContain(path.dirname(library));
	});
});

describe("a subagent's usage", () => {
	it("shows new and cached prompt tokens and marks a child on a model without pricing", async () => {
		const s = setup();
		const result = await s.run({ goal: GOAL, task: "unpriced answer" });
		expect(result.details).toMatchObject({ input: 400, cacheRead: 300, output: 20, cost: 0, unpriced: true });
		const done = rendered(
			s.agent.renderResult(result, { isPartial: false, expanded: true }, theme, {
				isError: false,
				expanded: true,
				durationMs: 250,
			}),
		);
		// Tokens and cost are in the expanded summary; the duration is drawn only in the header.
		expect(done).toMatch(
			/^  ⎿  Done · [a-z]+-[a-z]+ · ↑100 \+300 cached ↓20 · cost n\/a · conversation cache: 75% cached · 300 read · 0 written\n/,
		);
		expect(done).not.toContain("250ms");
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
