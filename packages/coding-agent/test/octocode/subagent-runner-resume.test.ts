import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAcp } from "../../src/octocode/external/acp-host.ts";
import { headlessRoute } from "../../src/octocode/external/headless/routes.ts";
import { runnerTurn, type RunnerTurnInput } from "../../src/octocode/external/runner-session.ts";
import type { Runners } from "../../src/octocode/subagents/runner-port.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-runner-resume-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team", "team.sqlite"),
	});
});
afterAll(() => {
	process.env = savedEnv;
});

/**
 * A stand-in `codex` (never the vendor's CLI): it journals each run's argv and stdin, then plays one turn of
 * `codex exec --json`, naming its thread only when `threadId` is given.
 */
function fakeCodex(threadId: string | undefined) {
	const home = tmp("octocode-runner-resume-cli-");
	const journal = path.join(home, "journal.jsonl");
	const command = path.join(home, "codex");
	const events = [
		...(threadId ? [{ type: "thread.started", thread_id: threadId }] : []),
		{ type: "item.completed", item: { type: "agent_message", text: "done: ok\nNoticed: none" } },
		{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
	];
	fs.writeFileSync(
		command,
		`#!${process.execPath}\nlet s = "";\nprocess.stdin.on("data", (c) => (s += c));\nprocess.stdin.on("end", () => {\nrequire("node:fs").appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ args: process.argv.slice(2), stdin: s }) + "\\n");\nfor (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));\n});\n`,
		{ mode: 0o755 },
	);
	const runs = () =>
		fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { args: string[]; stdin: string });
	const runners: Runners = {
		ids: ["codex"],
		turn: (input: RunnerTurnInput) =>
			runnerTurn(input, {
				launch: () => ({
					command,
					args: [...headlessRoute("codex")!.args],
					billing: "plan",
					route: "headless",
				}),
				connect: connectAcp,
				permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
			}),
	};
	return { runners, runs };
}

/** The `agent` calls and results a session records: what `resume` finds the child in. */
const recorded = (calls: Array<{ input: Record<string, unknown>; details: Record<string, unknown> }>): unknown[] =>
	calls.flatMap(({ input, details }, index) => [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name: "agent", arguments: { type: "task", ...input } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "agent",
				isError: false,
				details: { ...details, agentType: "task" },
			},
		},
	]);

function session(runners: Runners) {
	const f = fakeHost();
	const team = new Team(f.api);
	registerAgentTool(f.api, { profiles: () => new Map(), team, permission: fakePermission(), runners });
	const ctx = fakeCtx({ cwd: tmp("octocode-runner-resume-cwd-"), hasUI: true });
	const entries: unknown[] = [];
	Object.assign(ctx.sessionManager, { getEntries: () => entries });
	team.start(ctx);
	const calls: Array<{ input: Record<string, unknown>; details: Record<string, unknown> }> = [];
	/** One `agent` call; its input and result join the entries a later resume reads. */
	const call = async (input: Record<string, unknown>) => {
		const result = (await f.tools.get("agent").execute("c", input, undefined, undefined, ctx)) as {
			details: Record<string, unknown>;
		};
		calls.push({ input, details: structuredClone(result.details) });
		entries.splice(0, entries.length, ...recorded(calls));
		return result;
	};
	return { call, team };
}

describe("resuming a runner child through the agent tool", () => {
	it("passes the session id its CLI reported to the route's resume argv, on every later resume", async () => {
		const cli = fakeCodex(ID);
		const s = session(cli.runners);
		try {
			const first = await s.call({ task: "Read src", goal: "read src", runner: "codex" });
			expect(first.details).toMatchObject({ runnerSession: ID });
			const id = first.details.id as string;

			// https://developers.openai.com/codex/noninteractive: `codex exec resume <id>`; no `runner` is named on a resume.
			const second = await s.call({ task: "Now read tests", goal: "read tests", resume: id });
			expect(second.details).toMatchObject({ id, runnerSession: ID });
			const [firstRun, secondRun] = cli.runs();
			expect(firstRun?.args).not.toContain("resume");
			expect(secondRun?.args.slice(-3)).toEqual(["resume", ID, "-"]);
			expect(secondRun?.stdin).toContain("Now read tests");

			await s.call({ task: "And once more", goal: "again", resume: id });
			expect(cli.runs()[2]?.args.slice(-3)).toEqual(["resume", ID, "-"]);

			// The session lives in Codex: another runner cannot continue it.
			await expect(s.call({ task: "x", goal: "x", resume: id, runner: "claude-code" })).rejects.toThrow(
				/ran in codex; resume it without runner/,
			);
			expect(cli.runs()).toHaveLength(3);
		} finally {
			s.team.stop();
		}
	}, 30_000);

	it("refuses a resume when the CLI never reported a session", async () => {
		const cli = fakeCodex(undefined);
		const s = session(cli.runners);
		try {
			const first = await s.call({ task: "Read src", goal: "read src", runner: "codex" });
			expect(first.details).not.toHaveProperty("runnerSession");
			const id = first.details.id as string;
			await expect(s.call({ task: "more", goal: "more", resume: id })).rejects.toThrow(
				/ran in codex, which reported no session of its own/,
			);
			expect(cli.runs()).toHaveLength(1);
		} finally {
			s.team.stop();
		}
	}, 30_000);
});
