import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentModes } from "../../src/octocode/agent-tool.ts";
import { connectAcp } from "../../src/octocode/external/acp-host.ts";
import { runnerTurn, type RunnerTurnInput } from "../../src/octocode/external/runner-session.ts";
import { agentToolSpec } from "../../src/octocode/subagents/agent-tool.ts";
import { registerModelsTool } from "../../src/octocode/subagents/models-tool.ts";
import type { Runners } from "../../src/octocode/subagents/runner-port.ts";
import { registerChildRunnerTask } from "../../src/octocode/subagents/runner-task.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/external-acp-agent.mjs", import.meta.url));
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-runner-task-");
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
});
afterAll(() => {
	process.env = savedEnv;
});

/** Connected runners whose turns run in the scripted ACP peer: Claude Code's place, with no vendor CLI. */
function scriptedRunners(mode = "report") {
	const journal = path.join(tmp("octocode-runner-journal-"), "journal.jsonl");
	const runners: Runners = {
		ids: ["claude-code"],
		turn: (input: RunnerTurnInput) =>
			runnerTurn(input, {
				launch: () => ({ command: process.execPath, args: [fixture, mode, journal], billing: "plan" }),
				connect: connectAcp,
				permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
			}),
	};
	const prompts = () =>
		fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.event === "prompt")
			.map((entry) => entry.text as string);
	return { runners, journal, prompts };
}

describe("the runner field of agent tasks", () => {
	it("is declared only while a runner is connected", () => {
		expect(agentToolSpec().parameters.properties).not.toHaveProperty("runner");
		const runner = (agentToolSpec(["claude-code"]).parameters.properties as Record<string, { enum?: string[] }>).runner;
		expect(runner?.enum).toEqual(["claude-code"]);
	});

	it("adds the runner line to the unified task type only then", () => {
		const declared = (runners?: Runners) => {
			const f = fakeHost();
			const modes = agentModes();
			registerAgentTool(f.api, () => new Map(), new Team(f.api), fakePermission(), undefined, modes.collect, runners);
			modes.register(f.api);
			return f.tools.get("agent");
		};
		const plain = declared();
		expect(plain.description).not.toContain("runner");
		expect(plain.parameters.properties).not.toHaveProperty("runner");
		const withRunner = declared(scriptedRunners().runners);
		expect(withRunner.description).toContain("With runner, a connected vendor CLI does it on its own plan");
		expect(withRunner.parameters.properties.runner.enum).toEqual(["claude-code"]);
	});
});

describe("a task run by an external runner", () => {
	it("is a normal child item: named, given the report contract, and its report returns with plan billing", async () => {
		const f = fakeHost();
		const team = new Team(f.api);
		const { runners, prompts } = scriptedRunners();
		registerAgentTool(f.api, () => new Map(), team, fakePermission(), undefined, undefined, runners);
		const cwd = tmp("octocode-runner-cwd-");
		const ctx = fakeCtx({ cwd, hasUI: true });
		team.start(ctx);
		const result = await f.tools
			.get("agent")
			.execute(
				"call-1",
				{ task: "Read src/app.ts", goal: "read the app", runner: "claude-code" },
				undefined,
				undefined,
				ctx,
			);
		const text = result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
		expect(text).toContain("done: the runner read src/app.ts");
		expect(result.details).toMatchObject({
			goal: "read the app",
			outcome: "done",
			billing: "plan",
			model: "claude-code",
		});
		expect(result.details.id).toEqual(expect.any(String));
		// The runner got the task and the same report contract a native child gets, and nothing of Octocode's team.
		const [sent] = prompts();
		expect(sent).toMatch(/^Read src\/app\.ts\n\n## You\nYou run this task for Octocode/);
		expect(sent).toContain("## Report\nYour final answer is your report");
		// The run is over: its name is free and nothing is left running.
		expect(team.members().filter((member) => member.parentId)).toEqual([]);
	});

	it("refuses fields only an Octocode child takes, and a runner that is not connected", async () => {
		const f = fakeHost();
		const team = new Team(f.api);
		registerAgentTool(f.api, () => new Map(), team, fakePermission(), undefined, undefined, scriptedRunners().runners);
		const ctx = fakeCtx({ cwd: tmp("octocode-runner-refuse-"), hasUI: true });
		team.start(ctx);
		const run = (params: Record<string, unknown>) =>
			f.tools.get("agent").execute("c", params, undefined, undefined, ctx);
		await expect(run({ task: "x", goal: "g", runner: "claude-code", skills: [] })).rejects.toThrow(
			/runner task does not take skills/,
		);
		await expect(run({ task: "x", goal: "g", runner: "codex" })).rejects.toThrow(/Runner codex is not connected/);
	});

	it("can be started by a subagent: its task type then takes runner tasks only, and returns the runner's report", async () => {
		const { runners, prompts } = scriptedRunners();
		const f = fakeHost();
		const modes = agentModes();
		const asked: string[] = [];
		registerChildRunnerTask(
			runners,
			{
				check: vi.fn(async (_ctx, request) => {
					asked.push(request.title);
					return { allowed: true };
				}),
			},
			modes.collect,
		);
		modes.register(f.api);
		const agent = f.tools.get("agent");
		expect(agent.parameters.properties.runner.enum).toEqual(["claude-code"]);
		expect(agent.parameters.properties).not.toHaveProperty("tasks");
		expect(agent.description).toContain("connected vendor CLI");
		const cwd = tmp("octocode-runner-child-");
		const result = await agent.execute(
			"call-7",
			{
				type: "task",
				runner: "claude-code",
				goal: "read the app",
				task: "Read src/app.ts",
				reason: "a child delegates",
			},
			undefined,
			undefined,
			fakeCtx({ cwd }),
		);
		expect(asked).toEqual(["Start claude-code on this task?"]);
		expect(result.content[0].text).toContain("done: the runner read src/app.ts");
		expect(result.details).toMatchObject({
			runner: "claude-code",
			billing: "plan",
			outcome: "done",
			agentType: "task",
		});
		expect(prompts()[0]).toContain(`Work in \`${cwd}\``);
	});
});

describe("the models tool", () => {
	it("lists the blocks index.ts gives it, connected runners included, and nothing when the listing fails", async () => {
		const run = async (list: () => Promise<string[]>) => {
			let tool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> } | undefined;
			registerModelsTool(
				{ registerTool: (definition: never) => void (tool = definition) } as never,
				() => new Map(),
				list,
			);
			const result = await tool!.execute("c", {}, undefined, undefined, {
				model: { provider: "openai", id: "gpt-5", cost: { input: 5, output: 25 }, contextWindow: 200_000 },
				modelRegistry: {
					getAvailable: () => [],
					getAll: () => [],
					find: () => undefined,
					getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
				},
			});
			return result.content.map((part) => part.text).join("\n");
		};
		const rows = "Connected runners: pass `runner` on a task\n  ● claude-code · Claude Code 2.1.322 · claude.ai · plan";
		expect(await run(async () => [rows])).toContain(rows);
		expect(
			await run(async () => {
				throw new Error("boom");
			}),
		).not.toContain("Connected runners");
	});
});
