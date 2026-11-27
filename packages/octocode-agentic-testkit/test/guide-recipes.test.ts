// Runs the scripted recipes of GUIDE.md: keep both in sync.
import { afterEach, describe, expect, it } from "vitest";
import {
	analyzeSurface,
	maxToolCalls,
	mockMcp,
	never,
	surfaceOfRequest,
	referenceAdapter,
	script,
	scripts,
	startGateway,
	type Gateway,
	type MockMcp,
	type Step,
} from "../src/index.ts";
import { CLAUDE_CODE_LIMITS } from "../src/adapters/claude-code/index.ts";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const o of open.splice(0).reverse()) await o.close();
});

const tool = (name: string) => ({
	name,
	description: name,
	inputSchema: { type: "object" as const, properties: { query: { type: "string" }, id: { type: "string" } } },
});

async function setup(steps: Step[]): Promise<{ gw: Gateway; docs: MockMcp; run(p: string): Promise<unknown> }> {
	const gw = await startGateway({ responder: script(steps) });
	const docs = mockMcp({ name: "docs", trace: gw.trace, tools: [tool("search"), tool("fetch")] });
	const session = await referenceAdapter({ trace: gw.trace, mcp: [docs.client()] }).start({ gatewayUrl: gw.url });
	open.push(gw, docs, session);
	return { gw, docs, run: (p) => session.run(p) };
}

describe("GUIDE recipes", () => {
	it("recovers after an HTTP 429", async () => {
		const { gw, run } = await setup([{ error: { status: 429, retryAfterSeconds: 1 } }, { text: "done" }]);
		await expect(run("q")).rejects.toThrow();
		expect(gw.trace.of("answer")).toHaveLength(0);
		await run("q");
		expect(gw.trace.of("answer")).toHaveLength(1);
	});

	it("reflects after a tool failure without an identical retry", async () => {
		const { gw, docs, run } = await setup([
			{ toolCalls: [{ name: "search", args: { query: "cache" } }] },
			{ toolCalls: [{ name: "search", args: { query: "prompt cache" } }] },
			{ text: "done" },
		]);
		docs.tool("search").failOnce("error");
		await run("find the cache docs");
		expect(gw.trace).toReflect({ after: "error" });
		expect(gw.trace).toNotRetryIdentically("search");
	});

	it("checks call order and a budget", async () => {
		const { gw, run } = await setup([
			{ toolCalls: [{ name: "search", args: { query: "x" } }] },
			{ toolCalls: [{ name: "fetch", args: { id: "a" } }] },
			{ text: "done" },
		]);
		await run("q");
		expect(gw.trace).toFollowTrajectory(["search", { tool: "fetch", args: { id: "a" } }], { mode: "superset" });
		expect(gw.trace).not.toFollowTrajectory(["fetch", "search"]);
		expect(gw.trace).toStayWithin({ requests: 4, promptTokens: 20_000 });
		expect(gw.trace).not.toStayWithin({ requests: 2 });
	});

	it("blocks a forbidden call before it runs", async () => {
		const steps: Step[] = [{ toolCalls: [{ name: "delete_repo", args: { repo: "a/b" } }] }, { text: "done" }];
		const gw = await startGateway({ responder: script(steps), guards: [never("delete_*"), maxToolCalls(20)] });
		const repo = mockMcp({ name: "repo", trace: gw.trace, tools: [tool("delete_repo")] });
		const session = await referenceAdapter({ trace: gw.trace, mcp: [repo.client()] }).start({ gatewayUrl: gw.url });
		open.push(gw, repo, session);
		await session.run("clean up");
		expect(repo.tool("delete_repo")).not.toHaveBeenCalled();
		expect(gw.trace).toHaveBlocked("delete_repo");
	});

	it("caps and checks the spend", async () => {
		const gw = await startGateway({
			responder: script([{ text: "done" }]),
			caps: { pricing: { input: 1, output: 5 }, maxUsd: 0.05 },
		});
		const session = await referenceAdapter({ trace: gw.trace }).start({ gatewayUrl: gw.url });
		open.push(gw, session);
		await session.run("q");
		expect(gw.trace).toStayWithin({ usd: 0.06 });
	});

	it("reviews the tool surface the harness sent", async () => {
		const { gw, run } = await setup([{ text: "done" }]);
		await run("q");
		const report = analyzeSurface({ tools: surfaceOfRequest(gw.trace.requests[0]) }, CLAUDE_CODE_LIMITS);
		expect(report).toPassSurfaceReview({ allow: ["param-undocumented"] });
	});

	it("hands off between agents", async () => {
		const gw = await startGateway({
			responder: scripts({
				main: [{ toolCalls: [{ name: "spawn_agent", args: { role: "researcher", task: "look" } }] }, { text: "done" }],
				researcher: [{ text: "found it" }],
			}),
		});
		const session = await referenceAdapter({ trace: gw.trace }).start({ gatewayUrl: gw.url });
		open.push(gw, session);
		await session.run("research this");
		expect(gw.trace).toHaveHandedOff("main", "researcher");
		expect(gw.trace).toHaveNoOrphanAgents();
	});
});
