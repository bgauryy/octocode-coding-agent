import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startVitest, type TestCase } from "vitest/node";
import type { AgentAdapter } from "../src/adapter.ts";
import { referenceAdapter } from "../src/adapters/reference/index.ts";
import { script, type StepSource } from "../src/gateway.ts";
import { maxToolCalls, never } from "../src/guards.ts";
import type { StandardSchemaV1 } from "../src/matchers/answer.ts";
import type { ToolDef } from "../src/mcp.ts";
import { agentSuite, neededPasses, type ReplicaContext } from "../src/suite.ts";
import { searchTool } from "./helpers.ts";

const fetchTool: ToolDef = {
	name: "fetch",
	description: "Read one file",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	handler: () => "export const MAX_RETRIES = 3;",
};
const deleteTool: ToolDef = {
	name: "delete_repo",
	description: "Delete a repository permanently",
	inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
};
const docs = { docs: [searchTool, fetchTool, deleteTool] };

const reference = (ctx: ReplicaContext) => referenceAdapter({ trace: ctx.trace, conversation: true, maxTurns: 20 });
const call = (name: string, args: Record<string, unknown>): StepSource => ({ toolCalls: [{ name, args }] });

/** A JSON answer `{ answer: string, citation: "<path>:<line>" }`, as a hand-written Standard Schema. */
const Answer: StandardSchemaV1 = {
	"~standard": {
		version: 1,
		vendor: "test",
		validate: (v) => {
			const o = v as { answer?: unknown; citation?: unknown } | null;
			const issues = [
				...(typeof o?.answer === "string" ? [] : [{ message: "must be a string", path: ["answer"] }]),
				...(typeof o?.citation === "string" && /:\d+$/.test(o.citation)
					? []
					: [{ message: "must end in :<line>", path: ["citation"] }]),
			];
			return issues.length ? { issues } : { value: v };
		},
	},
};

const research = script([
	call("search", { query: "MAX_RETRIES" }),
	call("fetch", { path: "src/retry.ts" }),
	{ text: '```json\n{"answer":"3","citation":"src/retry.ts:42"}\n```' },
	{ text: "It was in src/retry.ts." },
]);

agentSuite(
	"research flow: a fresh agent per run, each test its next turn",
	{ adapter: reference, gateway: { responder: research }, mcp: docs, runs: 3, guards: [never("delete_*")] },
	(t) => {
		t.test("turn 1 searches, reads, and answers in schema", async ({ run, mcp, expect }) => {
			const turn = await run("What is MAX_RETRIES?");
			expect(turn.trace).toHaveCalledMcp("docs", "search", { args: { query: "MAX_RETRIES" }, before: "answer" });
			expect(turn.trace).toFollowTrajectory(["search", { tool: "fetch", args: { path: "src/retry.ts" } }]);
			expect(turn.trace).not.toHaveCalledTool("delete_*");
			expect(mcp.docs.tool("search")).toHaveBeenCalledBefore(mcp.docs.tool("fetch"));
			expect(turn.trace).toMatchSchema(Answer);
			expect(turn.answer).toContain('"citation"');
			expect(turn.stopped).toBeUndefined();
		});

		t.test("turn 2 continues the same conversation", async ({ run, trace, mcp, expect }) => {
			const turn = await run("Which file was that?");
			expect(turn.answer).toBe("It was in src/retry.ts.");
			expect(turn.trace.of("model_tool_call")).toHaveLength(0);
			// Vitest clears spy history before each test (clearMocks); the trace keeps every turn.
			expect(mcp.docs.tool("search")).not.toHaveBeenCalled();
			expect(trace).toHaveCalledMcp("docs", "search", { times: 1 });
			expect(trace.requests).toHaveLength(4);
			expect(trace).toKeepStablePrefix();
		});
	},
);

agentSuite(
	"a new describe starts new agents, traces and spies",
	{ adapter: reference, gateway: { responder: research }, mcp: docs, runs: 2 },
	(t) => {
		t.test("nothing happened before the first turn", async ({ run, trace, mcp, replica, expect }) => {
			expect(trace.requests).toHaveLength(0);
			expect(mcp.docs.tool("search")).not.toHaveBeenCalled();
			expect([0, 1]).toContain(replica);
			await run("What is MAX_RETRIES?");
			expect(mcp.docs.tool("search")).toHaveBeenCalledTimes(1);
		});
	},
);

/** Runs 1 and 2 search; run 0 answers at once. */
const flaky = (replica: number) => ({
	responder: script(replica === 0 ? [{ text: "no idea" }] : [call("search", { query: "x" }), { text: "done" }]),
});

agentSuite(
	"2 of 3 runs pass a 0.6 policy",
	{ adapter: reference, gateway: flaky, mcp: docs, runs: 3, pass: 0.6 },
	(t) => {
		t.test("calls search", async ({ run, expect }) => {
			expect((await run("find x")).trace).toHaveCalledMcp("docs", "search");
		});
	},
);

agentSuite("the same runs fail pass all", { adapter: reference, gateway: flaky, mcp: docs, runs: 3 }, (t) => {
	t.test(
		"calls search",
		async ({ run, expect }) => expect((await run("find x")).trace).toHaveCalledMcp("docs", "search"),
		{
			fails: true,
		},
	);
});

agentSuite(
	"isolation: test gives each test a fresh agent",
	{ adapter: reference, gateway: { responder: research }, mcp: docs, isolation: "test" },
	(t) => {
		for (const n of [1, 2])
			t.test(`test ${n} starts empty`, async ({ run, trace, mcp, expect }) => {
				expect(trace.requests).toHaveLength(0);
				await run("What is MAX_RETRIES?");
				expect(mcp.docs.tool("search")).toHaveBeenCalledTimes(1);
			});
	},
);

const loop = { responder: script([call("search", { query: "again" })]) };

agentSuite(
	"budgetUsd stops a looping agent",
	{ adapter: reference, gateway: loop, mcp: docs, budgetUsd: 0.2, pricing: { input: 1000, output: 1000 } },
	(t) => {
		t.test(
			"the turn stops on the budget cap",
			async ({ run, trace, expect }) => {
				const turn = await run("loop");
				expect(turn.stopped).toMatch(/^cut: budget cap \$0\.2/);
				expect(trace).toStayWithin({ usd: 0.2 + trace.requests.at(-2)!.costUsd! });
			},
			{ allowStop: true },
		);
		t.test("a run out of budget fails its later turns", async ({ run }) => void (await run("again?")), { fails: true });
	},
);

agentSuite(
	"budgetUsd caps the whole describe under isolation: test",
	{
		adapter: reference,
		gateway: loop,
		mcp: docs,
		isolation: "test",
		budgetUsd: 0.2,
		pricing: { input: 1000, output: 1000 },
	},
	(t) => {
		t.test(
			"test 1 spends the share",
			async ({ run, expect }) => expect((await run("loop")).stopped).toMatch(/budget cap/),
			{
				allowStop: true,
			},
		);
		t.test("test 2 starts fresh but has no budget left", async ({ run, trace, expect }) => {
			await expect(run("loop")).rejects.toThrow("run 0 stopped earlier: budget share $0.2000 spent");
			expect(trace.requests).toHaveLength(0);
		});
	},
);

const guarded = { adapter: reference, gateway: loop, mcp: docs, guards: [maxToolCalls(2)], isolation: "test" } as const;

agentSuite("a guard stop fails the turn unless allowed", guarded, (t) => {
	t.test("stopped by maxToolCalls", async ({ run }) => void (await run("loop")), { fails: true });
	t.test(
		"allowStop accepts the stop",
		async ({ run, mcp, expect }) => {
			const turn = await run("loop");
			expect(turn.stopped).toMatch(/^guard: more than 2 tool calls/);
			expect(turn.trace).toHaveBlocked("search");
			expect(mcp.docs.tool("search")).toHaveBeenCalledTimes(2);
		},
		{ allowStop: true },
	);
});

const missing: AgentAdapter = {
	name: "missing-cli",
	unavailable: () => "`missing-cli` not found",
	start: () => Promise.reject(new Error("must not start")),
};

agentSuite("an unavailable adapter skips with its reason", { adapter: missing }, (t) => {
	t.test("never runs", () => {
		throw new Error("the body must not run");
	});
});

agentSuite("skip skips every test", { adapter: reference, skip: "no tier configured" }, (t) => {
	t.test("never runs", () => {
		throw new Error("the body must not run");
	});
});

describe("agentSuite options", () => {
	it("computes the passes a policy needs", () => {
		expect(neededPasses("all", 5)).toBe(5);
		expect(neededPasses("any", 5)).toBe(1);
		expect(neededPasses(0.6, 3)).toBe(2);
		expect(neededPasses(0.8, 5)).toBe(4);
		expect(() => neededPasses(0, 3)).toThrow(RangeError);
		expect(() => neededPasses(1.5, 3)).toThrow(RangeError);
	});

	it("rejects a budget without pricing and a bad run count when defined", () => {
		expect(() => agentSuite("x", { adapter: missing, budgetUsd: 1 }, () => {})).toThrow(/budgetUsd needs pricing/);
		expect(() => agentSuite("x", { adapter: missing, runs: 0 }, () => {})).toThrow(/runs=0/);
	});
});

const SRC = resolve(import.meta.dirname, "../src");

/** Suites under a config that retries, repeats and shuffles, one of them inside a concurrent describe. */
const RERUN_FIXTURE = `
import { beforeAll, describe } from "vitest";
import { referenceAdapter } from "${SRC}/adapters/reference/index.ts";
import { script } from "${SRC}/gateway.ts";
import { agentSuite } from "${SRC}/suite.ts";

const scripted = (...answers) => ({
	adapter: ({ trace }) => referenceAdapter({ trace, conversation: true }),
	gateway: { responder: script(answers.map((text) => ({ text }))) },
});
const answersRight = (t) =>
	t.test("turn 1 answers right", async ({ run, expect }) => expect((await run("q")).answer).toBe("right"));

agentSuite("config retry", scripted("wrong", "right"), answersRight);

describe("forced retry", () => {
	// A retry set after collection, past the suite's own options.
	beforeAll(({}, suite) => {
		for (const s of suite.tasks) for (const t of s.tasks ?? []) t.retry = 1;
	});
	agentSuite("inner", scripted("wrong", "right"), answersRight);
});

const turns = ["one", "two", "three", "four", "five"];
let inFlight = 0;
const inOrder = (t) => {
	for (const [i, want] of turns.entries())
		t.test(\`turn \${i + 1}\`, async ({ run, expect }) => {
			inFlight++;
			try {
				expect(inFlight).toBe(1);
				expect((await run("q")).answer).toBe(want);
			} finally {
				inFlight--;
			}
		});
};

agentSuite("order", scripted(...turns), inOrder);

describe("concurrent", { concurrent: true }, () => agentSuite("inner", scripted(...turns), inOrder));
`;

describe("agentSuite under Vitest retry, repeats, shuffle and concurrency", () => {
	it("a failed turn stays failed: no retry or repeat grades the next turn, and turns keep their order", async () => {
		const tmp = resolve(import.meta.dirname, "../../../.octocode/tmp");
		mkdirSync(tmp, { recursive: true });
		const dir = mkdtempSync(join(tmp, "suite-rerun-"));
		writeFileSync(join(dir, "rerun.fixture.test.ts"), RERUN_FIXTURE);
		const exitCode = process.exitCode;
		try {
			const vitest = await startVitest([], {
				root: dir,
				config: false,
				watch: false,
				include: ["rerun.fixture.test.ts"],
				retry: 1,
				repeats: 1,
				sequence: { shuffle: true, seed: 3 },
				reporters: [{}],
				pool: "threads",
				testTimeout: 20_000,
			});
			const cases = new Map<string, TestCase>();
			for (const m of vitest.state.getTestModules()) for (const c of m.children.allTests()) cases.set(c.fullName, c);
			const errors = (name: string): string =>
				(cases.get(name)?.result().errors ?? []).map((e) => e.message).join("\n");
			const plain = cases.get("config retry > turn 1 answers right");
			expect(plain?.result().state).toBe("failed");
			expect(plain?.attempts()).toHaveLength(1);
			expect(errors("config retry > turn 1 answers right")).toMatch(/expected 'wrong' to be 'right'/);
			const forced = "forced retry > inner > turn 1 answers right";
			expect(cases.get(forced)?.result().state).toBe("failed");
			expect(errors(forced)).toMatch(/ran again \(retry 1\)/);
			for (const prefix of ["order > ", "concurrent > inner > "]) {
				const turns = [...cases.values()].filter((c) => c.fullName.startsWith(prefix));
				expect(turns.map((c) => c.result().state)).toEqual(Array(5).fill("passed"));
			}
		} finally {
			process.exitCode = exitCode;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
