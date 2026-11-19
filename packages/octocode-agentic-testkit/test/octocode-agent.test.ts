import "./bundle.ts";
import { describe, expect, it } from "vitest";
import {
	octocodeAgentAvailable,
	parseSkillListing,
	runOctocodeAgent,
	type OctocodeAgentRun,
} from "../src/adapters/octocode-agent/index.ts";
import { cacheReadRatio, duplicateBlocks, prefixBreaks } from "../src/context.ts";
import { script, type StepSource } from "../src/gateway.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";
import { PROMPTS } from "./triggers/matrix.ts";

const SKIP = "octocode-agent bundle missing: run `yarn run build:offline` first";

async function drive(steps: StepSource[], prompt: string, files?: Record<string, string>) {
	const gw = await gateway({ responder: script(steps) });
	const run = await runOctocodeAgent({ gatewayUrl: gw.url, prompt, files, timeoutMs: 90_000 });
	return { gw, run };
}

function report(label: string, gw: Awaited<ReturnType<typeof drive>>["gw"], run: OctocodeAgentRun): void {
	const reqs = gw.trace.requests;
	const raw0 = reqs[0]?.raw as { tools?: unknown[] } | undefined;
	console.info(
		`[octocode-agent:${label}] ${JSON.stringify({
			requests: reqs.length,
			agents: [...new Set(reqs.map((r) => r.agent))],
			toolCount: reqs[0]?.tools.length,
			toolBytes: Buffer.byteLength(JSON.stringify(raw0?.tools ?? [])),
			systemChars: String(reqs[0]?.messages[0]?.content ?? "").length,
			requestBytes: reqs.map((r) => r.bytes),
			prefixBreaks: prefixBreaks(gw.trace).length,
			cacheRatio: Number(cacheReadRatio(gw.trace).toFixed(3)),
			duplicateBlocks: duplicateBlocks(gw.trace).length,
			streamed: reqs.map((r) => r.stream),
			exitCode: run.exitCode,
			durationMs: run.durationMs,
		})}`,
	);
}

describe("octocode-agent via gateway", () => {
	it("scripted bash call executes and its result reaches the next request", async (ctx) => {
		if (!octocodeAgentAvailable()) return ctx.skip(SKIP);
		const { gw, run } = await drive(
			[{ toolCalls: [{ name: "bash", args: { command: "cat hello.txt" } }] }, { text: "the file says hello" }],
			"read hello.txt",
			{ "hello.txt": "HELLO-FIXTURE\n" },
		);
		report("bash", gw, run);
		expect(run.stderr).not.toMatch(/not found|error/i);
		expect(run.exitCode).toBe(0);
		const first = gw.trace.requests[0];
		expect(first.messages[0].role).toBe("system");
		expect(String(first.messages[0].content)).toContain("Octocode");
		expect(first.tools).toEqual(expect.arrayContaining(["bash", "file", "skill"]));
		expect(gw.trace).toHaveCalledTool("bash", { args: { command: "cat hello.txt" }, before: "answer" });
		expect(JSON.stringify(gw.trace.requests[1].messages)).toContain("HELLO-FIXTURE");
		expect(run.events.some((e) => e.type === "agent_end")).toBe(true);
		expect(gw.trace.of("answer")[0].data).toBe("the file says hello");
		expect(gw.trace).toKeepStablePrefix();
		expect(gw.trace).toHaveNoDuplicateBlocks();
		expect(gw.errors).toEqual([]);
	});

	it("detects a skill load through the skill tool", async (ctx) => {
		if (!octocodeAgentAvailable()) return ctx.skip(SKIP);
		const { gw, run } = await drive(
			[
				{ toolCalls: [{ name: "skill", args: { name: "octocode-local-research", reason: "testkit" } }] },
				{ text: "loaded" },
			],
			"use a skill",
		);
		report("skill", gw, run);
		expect(gw.trace).toHaveLoadedSkill("octocode-local-research");
		expect(gw.trace).not.toHaveLoadedSkill("octocode-pr-review");
	});

	it("the trigger matrix has a fire and a near-miss prompt for every skill the bundle lists", async (ctx) => {
		if (!octocodeAgentAvailable()) return ctx.skip(SKIP);
		const { gw } = await drive([{ text: "ok" }], "hi");
		const listed = parseSkillListing(String(gw.trace.requests[0].messages[0].content)).map((s) => s.name);
		expect(listed.length).toBeGreaterThan(0);
		expect(listed.filter((name) => !PROMPTS[name])).toEqual([]);
	});

	it("an unknown tool call gets an error result and the run still finishes", async (ctx) => {
		if (!octocodeAgentAvailable()) return ctx.skip(SKIP);
		const { gw, run } = await drive(
			[{ toolCalls: [{ name: "does_not_exist", args: {} }] }, { text: "ok" }],
			"call a bad tool",
		);
		report("unknown-tool", gw, run);
		expect(run.exitCode).toBe(0);
		console.info(
			"[octocode-agent:unknown-tool] tool result:",
			JSON.stringify(gw.trace.requests[1]?.messages.at(-1)).slice(0, 300),
		);
		expect(gw.trace.requests.length).toBeGreaterThanOrEqual(2);
	});

	it("calls a mock MCP tool as mcp__<server>__<tool>; failOnce(error) reaches the model", async (ctx) => {
		if (!octocodeAgentAvailable()) return ctx.skip(SKIP);
		const gw = await gateway({
			responder: script([
				{ toolCalls: [{ name: "mcp__docs__search", args: { query: "cache" } }] },
				{ toolCalls: [{ name: "mcp__docs__search", args: { query: "cache again" } }] },
				{ text: "done" },
			]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		docs.tool("search").failOnce("error").returns("RESULT-42");
		const run = await runOctocodeAgent({ gatewayUrl: gw.url, prompt: "search the docs", mcp: [docs] });
		report("mcp", gw, run);
		console.info(
			"[octocode-agent:mcp] tools:",
			JSON.stringify(gw.trace.requests[0]?.tools.filter((t) => t.includes("docs"))),
		);
		expect(run.exitCode).toBe(0);
		expect(gw.trace.requests[0].tools).toContain("mcp__docs__search");
		expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache again" }, before: "answer" });
		expect(gw.trace.of("tool_error")[0]).toMatchObject({ server: "docs", agent: "main", data: { reason: "error" } });
		expect(JSON.stringify(gw.trace.requests[1].messages.at(-1))).toContain("injected error");
		expect(JSON.stringify(gw.trace.requests[2].messages)).toContain("RESULT-42");
		expect(gw.trace).toKeepStablePrefix();
	});
});
