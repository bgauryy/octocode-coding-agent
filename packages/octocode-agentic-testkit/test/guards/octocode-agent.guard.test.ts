import "../bundle.ts";
import { describe, expect, it } from "vitest";
import { runOctocodeAgent } from "../../src/adapters/octocode-agent/index.ts";
import { cacheReadRatio } from "../../src/context.ts";
import { script, scripts, type Responder } from "../../src/gateway.ts";
import { gateway, mcp, searchTool } from "../helpers.ts";
import { requireBundle } from "./support.ts";

/** Measured on the bundled agent (main agent, request 1), plus ~5%. Raise only with a reviewed reason. */
const CEILING = {
	systemPromptBytes: 30_800,
	toolJsonBytes: 42_100,
	/** Warm requests (all but the first) must read at least this share of the prompt from cache. */
	warmCacheReadRatio: 0.9,
};

const bytes = (v: unknown): number => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));

describe("octocode-agent guards (scripted gateway, real bundle)", () => {
	it("prompt budget: request-1 system prompt and tool JSON stay under their ceilings", async (ctx) => {
		requireBundle(ctx);
		const gw = await gateway({ responder: script([{ text: "ok" }]) });
		const run = await runOctocodeAgent({ gatewayUrl: gw.url, prompt: "hi" });
		expect(run.exitCode).toBe(0);
		const first = gw.trace.requests[0];
		const measured = {
			systemPromptBytes: bytes(first.messages[0].content),
			toolJsonBytes: bytes((first.raw as { tools?: unknown }).tools ?? []),
		};
		console.info(`[guard:prompt-budget] ${JSON.stringify({ measured, ceiling: CEILING })}`);
		for (const k of ["systemPromptBytes", "toolJsonBytes"] as const)
			expect(measured[k], `${k}: measured ${measured[k]} vs ceiling ${CEILING[k]}`).toBeLessThanOrEqual(CEILING[k]);
	});

	it("cache prefix: a 3-turn run keeps the raw prefix and warm requests read from cache", async (ctx) => {
		requireBundle(ctx);
		const gw = await gateway({
			responder: script([
				{ toolCalls: [{ name: "bash", args: { command: "cat a.txt" } }] },
				{ toolCalls: [{ name: "bash", args: { command: "cat b.txt" } }] },
				{ text: "done" },
			]),
		});
		const run = await runOctocodeAgent({
			gatewayUrl: gw.url,
			prompt: "read a.txt then b.txt",
			files: { "a.txt": "AAA\n", "b.txt": "BBB\n" },
		});
		expect(run.exitCode).toBe(0);
		expect(gw.trace.requests).toHaveLength(3);
		expect(gw.trace).toKeepStablePrefix({ raw: true });
		const [cold, ...warm] = gw.trace.requests;
		const coldRatio = (cold.usage?.cachedTokens ?? 0) / Math.max(1, cold.usage?.promptTokens ?? 1);
		const warmTrace = { ...gw.trace, requests: warm } as typeof gw.trace;
		const warmRatio = cacheReadRatio(warmTrace);
		console.info(
			`[guard:cache] ${JSON.stringify({ coldRatio, warmRatio: Number(warmRatio.toFixed(3)), overall: Number(cacheReadRatio(gw.trace).toFixed(3)) })}`,
		);
		expect(coldRatio).toBe(0);
		expect(warmRatio, `warm cacheReadRatio ${warmRatio} vs floor ${CEILING.warmCacheReadRatio}`).toBeGreaterThanOrEqual(
			CEILING.warmCacheReadRatio,
		);
	});

	it("MCP contract: called before the answer; an injected error reaches the model, which changes its args", async (ctx) => {
		requireBundle(ctx);
		const gw = await gateway({
			responder: script([
				{ toolCalls: [{ name: "mcp__docs__search", args: { query: "cache" } }] },
				{ toolCalls: [{ name: "mcp__docs__search", args: { query: "cache invalidation" } }] },
				{ text: "done" },
			]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		docs.tool("search").failOnce("error").returns("RESULT-42");
		const run = await runOctocodeAgent({ gatewayUrl: gw.url, prompt: "search the docs", mcp: [docs] });
		expect(run.exitCode).toBe(0);
		// The failed call never reaches the server as an execution, so it shows as a model call plus a tool_error.
		expect(gw.trace).toHaveCalledTool("mcp__docs__search", { args: { query: "cache" }, before: "answer" });
		expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache invalidation" }, before: "answer" });
		expect(JSON.stringify(gw.trace.requests[1].messages.at(-1))).toContain("injected error");
		expect(gw.trace).toReflect({ after: "error" });
		// The matcher keys errors by the server-side tool name and model calls by the prefixed one, so it cannot pair
		// them here (it passes vacuously); compare the two model calls directly as well.
		expect(gw.trace).toNotRetryIdentically("search");
		const calls = gw.trace.of("model_tool_call").filter((e) => e.name === "mcp__docs__search");
		expect(calls).toHaveLength(2);
		expect(calls[1].args).not.toEqual(calls[0].args);
		expect(JSON.stringify(gw.trace.requests[2].messages)).toContain("RESULT-42");
	});

	it("subagent flow: the agent tool (type task) starts a child whose report returns to main", async (ctx) => {
		requireBundle(ctx);
		// The harness sends no per-agent header: the gateway infers the child from the spawn call's task text and
		// routes its requests to the `task` script. The child is also the session without the main-only `backlog` tool.
		const isChild = (tools: string[]): boolean => !tools.includes("backlog");
		const responder: Responder = scripts({
			main: [
				{
					toolCalls: [
						{
							name: "agent",
							args: { type: "task", reason: "guard", goal: "Check a thing", task: "Reply CHILD-REPORT-7" },
						},
					],
				},
				{ text: "main finished" },
			],
			task: [{ text: "done. CHILD-REPORT-7" }],
		});
		const gw = await gateway({ responder });
		const run = await runOctocodeAgent({ gatewayUrl: gw.url, prompt: "delegate a check", timeoutMs: 80_000 });
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toMatch(/agent\.spawn × 1/);
		const reqs = gw.trace.requests;
		const child = reqs.filter((r) => isChild(r.tools));
		const main = reqs.filter((r) => !isChild(r.tools));
		expect(child.length, "child requests arrived").toBeGreaterThanOrEqual(1);
		expect(String(child[0].messages[0].content)).not.toBe(String(main[0].messages[0].content));
		expect(JSON.stringify(child[0].messages.at(-1))).toContain("Reply CHILD-REPORT-7");
		// The child report returns to main as the tool result of the next main request.
		expect(JSON.stringify(main[1].messages)).toContain("CHILD-REPORT-7");
		// No orphans: the child's last request precedes main's final request, and nothing arrives after main answers.
		expect(reqs.at(-1)).toBe(main.at(-1));
		expect(gw.trace.of("answer").at(-1)?.data).toBe("main finished");
		expect(gw.errors).toEqual([]);
		// The lineage agrees with the tool-set heuristic, and the flow matchers work on the real harness.
		expect(gw.trace.agent("task").requests.every((r) => isChild(r.tools))).toBe(true);
		expect(gw.trace.agent("main").requests.every((r) => !isChild(r.tools))).toBe(true);
		expect(gw.trace).toHaveSpawned("task", { times: 1 });
		expect(gw.trace).toHaveHandedOff("main", "task");
		expect(gw.trace).toHaveNoOrphanAgents();
	});
});
