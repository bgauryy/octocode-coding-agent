import "../bundle.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainJudgement, judge, type Criterion, type Judgement } from "../../src/judge.ts";
import type { Forward } from "../../src/upstream.ts";
import { requireBundle } from "../guards/support.ts";
import { gateway, mcp } from "../helpers.ts";
import { startRecordingProxy, type AgentRun, type ProbeRequest } from "./cache-probe.ts";
import { loadProvider, runScenario, type ScenarioRun } from "./judge-scenarios/run.ts";
import { SCENARIOS, type Scenario } from "./judge-scenarios/scenarios.ts";
import { transcriptOf } from "./judge-scenarios/transcript.ts";

/**
 * B607: does the agent still load and use what it needs after the cache-layout changes? Live Haiku runs the real bundle
 * through a recording proxy in each scenario; a Sonnet judge (`judge()`) grades the transcript against written
 * criteria. A negative control feeds the judge a transcript that fails them. Costs money: TESTKIT_LIVE=1 only, and
 * spend is tracked against a hard cap.
 */

const LIVE = process.env.TESTKIT_LIVE === "1";
const BUNDLE = process.env.TESTKIT_OCTOCODECODE_BUNDLE ?? "";
const OUT = process.env.TESTKIT_JUDGE_DIR ?? join(process.cwd(), ".octocode", "tmp", "testkit-judge");
const CAP_USD = 4.5;

/** Conservative USD per MTok (input, cache read, cache write, output): above the shipped model data, so spend is overestimated. */
const PRICE = {
	haiku: { input: 1, read: 0.1, write: 1.25, output: 5 },
	sonnet: { input: 3, read: 0.3, write: 3.75, output: 15 },
};
let spent = 0;

const haikuCost = (rs: ProbeRequest[]): number =>
	rs.reduce(
		(s, r) =>
			s +
			(r.usage.uncached * PRICE.haiku.input +
				r.usage.cacheRead * PRICE.haiku.read +
				r.usage.cacheWrite * PRICE.haiku.write +
				r.usage.output * PRICE.haiku.output) /
				1e6,
		0,
	);

const judgeCost = (j: Judgement): number =>
	(j.usage.promptTokens * PRICE.sonnet.input + j.usage.completionTokens * PRICE.sonnet.output) / 1e6;

function judgeModel(): Forward | string {
	const p = loadProvider("anthropic-custom", "claude-sonnet-5-5");
	if (typeof p === "string") return p;
	return { baseUrl: p.upstreamBase, model: "claude-sonnet-5-5", api: "anthropic", key: p.key, timeoutMs: 120_000 };
}

function save(name: string, data: unknown): string {
	mkdirSync(OUT, { recursive: true });
	const file = join(OUT, `${name}.json`);
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
	return file;
}

async function play(sc: Scenario): Promise<{ run: AgentRun; requests: ProbeRequest[]; calls: Record<string, number> }> {
	const provider = loadProvider("anthropic-custom", "claude-haiku-5-5");
	if (typeof provider === "string") throw new Error(provider);
	const proxy = await startRecordingProxy(provider.api, provider.upstreamBase);
	const gw = await gateway({});
	const config: ScenarioRun["mcpServers"] = {};
	const stubs: { name: string; tool: (t: string) => { mock: { calls: unknown[] } } }[] = [];
	for (const stub of sc.mcp ?? []) {
		const m = mcp(gw, stub.name, stub.tools);
		for (const [tool, val] of Object.entries(stub.returns ?? {})) m.tool(tool).returns(val);
		config[stub.name] = { url: await m.listen(), toolExposure: stub.toolExposure, description: stub.description };
		stubs.push({ name: stub.name, tool: (t) => m.tool(t) });
	}
	try {
		const run = await runScenario({
			bundle: BUNDLE,
			provider,
			baseUrl: proxy.url,
			prompts: sc.prompts,
			mcpServers: config,
			skills: sc.skills,
			settings: sc.settings,
			files: sc.files,
		});
		const calls: Record<string, number> = {};
		for (const s of stubs)
			for (const t of sc.mcp?.find((x) => x.name === s.name)?.tools ?? [])
				calls[`${s.name}.${t.name}`] = s.tool(t.name).mock.calls.length;
		return { run, requests: proxy.requests.filter((r) => r.path && r.bodyBytes > 0), calls };
	} finally {
		await proxy.close();
	}
}

describe("Sonnet judge over Haiku transcripts of the real bundle (cache layout)", () => {
	const results: Record<string, { pass: boolean; usd: number; file: string }> = {};

	for (const sc of SCENARIOS) {
		it(`${sc.id}: ${sc.title}`, async (ctx) => {
			if (!LIVE) return ctx.skip("live judge eval: set TESTKIT_LIVE=1 (costs money)");
			requireBundle(ctx);
			const grader = judgeModel();
			if (typeof grader === "string") return ctx.skip(grader);
			if (spent > CAP_USD) return ctx.skip(`spend cap reached ($${spent.toFixed(3)})`);
			const { run, requests, calls } = await play(sc);
			// A run that never reached the model grades nothing: fail loudly instead of sending an empty transcript to the judge.
			expect(
				requests.length,
				`agent run made no model request (exit ${run.exitCode}): ${run.stderr.slice(-800)}`,
			).toBeGreaterThan(0);
			const transcript = transcriptOf(run.events);
			const facts = { calls, firstRequestTools: requests[0]?.tools ?? [], requests: requests.length };
			const j = await judge({
				rubric: sc.rubric,
				transcript: `${transcript}\n\n[harness facts] ${JSON.stringify(facts)}`,
				model: grader,
			});
			const usd = haikuCost(requests) + judgeCost(j);
			spent += usd;
			const file = save(sc.id, {
				id: sc.id,
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				facts,
				usd: Number(usd.toFixed(4)),
				judgement: j,
				transcript,
				stderrTail: run.stderr.slice(-800),
			});
			results[sc.id] = { pass: j.pass, usd, file };
			console.info(
				`[judge:${sc.id}] pass=${j.pass} usd=${usd.toFixed(4)} file=${file}\n${j.criteria.map((c) => `  ${c.pass ? "ok  " : "FAIL"} ${c.id}: ${c.reason}`).join("\n")}`,
			);
			sc.check?.({ run, requests, calls, transcript });
			expect(j.pass, explainJudgement(j)).toBe(true);
		}, 360_000);
	}

	it("negative control: the judge fails a transcript that skips the tool and invents the answer", async (ctx) => {
		if (!LIVE) return ctx.skip("live judge eval: set TESTKIT_LIVE=1 (costs money)");
		const grader = judgeModel();
		if (typeof grader === "string") return ctx.skip(grader);
		const sc = SCENARIOS[0];
		const bad = [
			`user: ${sc.prompts[0]}`,
			"assistant: I looked it up. The owner is Dana Whitfield and the code is AB-0000.",
			'[harness facts] {"calls":{},"requests":1}',
		].join("\n");
		const rubric: Criterion[] = sc.rubric;
		const j = await judge({ rubric, transcript: bad, model: grader });
		spent += judgeCost(j);
		const file = save("negative-control", { judgement: j, transcript: bad, usd: Number(judgeCost(j).toFixed(4)) });
		console.info(`[judge:negative-control] pass=${j.pass} file=${file}\n${explainJudgement(j)}`);
		expect(j.pass, "the judge must fail a transcript with no tool call and a made-up answer").toBe(false);
		expect(j.criteria.some((c) => !c.pass)).toBe(true);
	}, 120_000);

	it("spend stays within the cap", (ctx) => {
		if (!LIVE) return ctx.skip("live judge eval: set TESTKIT_LIVE=1");
		console.info(`[judge:total] estimated $${spent.toFixed(4)} (conservative prices) ${JSON.stringify(results)}`);
		expect(spent).toBeLessThanOrEqual(5);
	});
});
