import { describe, expect, it } from "vitest";
import { referenceAdapter } from "../src/adapters/reference/index.ts";
import { script, startGateway } from "../src/gateway.ts";
import { maxToolCalls, never } from "../src/guards.ts";
import type { ToolDef } from "../src/mcp.ts";
import { spentUsd } from "../src/policy.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

const deleteTool: ToolDef = {
	name: "delete_repo",
	description: "Delete a repository permanently",
	inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
};

const call = (name: string, args: Record<string, unknown>) => ({ toolCalls: [{ name, args }] });

describe("gateway guards block a call before the harness sees it", () => {
	it("a forbidden call never runs, stays visible as an attempt, and cuts the trace", async () => {
		const gw = await gateway({
			responder: script([call("delete_repo", { repo: "acme/api" }), { text: "deleted" }]),
			guards: [never("delete_*")],
		});
		const repo = mcp(gw, "repo", [deleteTool]);
		const session = await referenceAdapter({ trace: gw.trace, mcp: [repo.client()] }).start({ gatewayUrl: gw.url });
		const r = await session.run("clean up acme/api");
		await session.close();

		expect(repo.tool("delete_repo")).not.toHaveBeenCalled();
		expect(gw.trace).toHaveBlocked("delete_repo");
		expect(gw.trace).toHaveCalledTool("delete_repo");
		expect(() => expect(gw.trace).not.toHaveCalledTool("delete_*")).toThrow(/not to be called/);
		expect(gw.trace.of("model_tool_call")[0].data).toEqual({
			blocked: 'forbidden call delete_repo({"repo":"acme/api"})',
		});
		expect(gw.trace.cut).toBe(true);
		expect(r.answer).toMatch(/^testkit: blocked delete_repo: forbidden call/);
		expect(gw.trace.of("answer")).toHaveLength(0);
	});

	it("drops every call of a reply when one of them is blocked", async () => {
		const gw = await gateway({
			responder: script([
				{
					toolCalls: [
						{ name: "search", args: { query: "x" } },
						{ name: "delete_repo", args: { repo: "a/b" } },
					],
				},
				{ text: "done" },
			]),
			guards: [never("delete_repo")],
		});
		const repo = mcp(gw, "repo", [searchTool, deleteTool]);
		const session = await referenceAdapter({ trace: gw.trace, mcp: [repo.client()] }).start({ gatewayUrl: gw.url });
		await session.run("go");
		await session.close();
		expect(repo.tool("search")).not.toHaveBeenCalled();
		expect(gw.trace.of("model_tool_call").map((e) => e.data)).toEqual([
			{ dropped: "call delete_repo in the same reply was blocked" },
			{ blocked: 'forbidden call delete_repo({"repo":"a/b"})' },
		]);
	});

	it("maxToolCalls stops a looping agent after the limit", async () => {
		const gw = await gateway({ responder: script([call("search", { query: "again" })]), guards: [maxToolCalls(2)] });
		const docs = mcp(gw, "docs", [searchTool]);
		const session = await referenceAdapter({ trace: gw.trace, mcp: [docs.client()], maxTurns: 10 }).start({
			gatewayUrl: gw.url,
		});
		await session.run("loop");
		await session.close();
		expect(docs.tool("search")).toHaveBeenCalledTimes(2);
		expect(gw.trace).toHaveBlocked("search");
		expect(gw.trace.requests).toHaveLength(3);
	});

	it("`when` limits a guard to matching arguments", async () => {
		const gw = await gateway({
			responder: script([call("search", { query: "public" }), call("search", { query: "secret" }), { text: "x" }]),
			guards: [never("search", (a) => a.query === "secret")],
		});
		const docs = mcp(gw, "docs", [searchTool]);
		const session = await referenceAdapter({ trace: gw.trace, mcp: [docs.client()] }).start({ gatewayUrl: gw.url });
		await session.run("go");
		await session.close();
		expect(docs.tool("search")).toHaveBeenCalledExactlyOnceWith({ query: "public" });
		expect(gw.trace.of("guard").map((e) => e.args)).toEqual([{ query: "secret" }]);
	});

	it("a trace with guards and no block passes .not.toHaveBlocked", async () => {
		const gw = await gateway({ responder: script([{ text: "hi" }]), guards: [never("delete_*")] });
		await referenceAdapter({ trace: gw.trace })
			.start({ gatewayUrl: gw.url })
			.then((s) => s.run("hello"));
		expect(gw.trace).not.toHaveBlocked();
	});
});

describe("mock MCP guards block at the wire", () => {
	it("answers a blocked call with an error result and never runs the tool", async () => {
		const gw = await gateway();
		const docs = mcp(gw, "docs", [searchTool]);
		const { mockMcp } = await import("../src/mcp.ts");
		const guarded = mockMcp({
			name: "guarded",
			tools: [deleteTool],
			trace: gw.trace,
			guards: [never("mcp__guarded__delete_*")],
		});
		const r = await guarded.client().callTool("delete_repo", { repo: "a/b" });
		await guarded.close();
		expect(r).toEqual({ isError: true, text: 'blocked: forbidden call delete_repo({"repo":"a/b"})' });
		expect(guarded.tool("delete_repo")).not.toHaveBeenCalled();
		expect(gw.trace.of("guard")[0]).toMatchObject({ server: "guarded", data: { by: "mcp:guarded" } });
		expect(docs.defs.map((d) => d.name)).toEqual(["search"]);
	});
});

describe("pricing and the USD cap", () => {
	// $1000 per million tokens: one estimated token costs $0.001.
	const pricing = { input: 1000, output: 1000 };

	it("prices every request and checks it with toStayWithin", async () => {
		const gw = await gateway({ responder: script([{ text: "hello there" }]), caps: { pricing } });
		await referenceAdapter({ trace: gw.trace })
			.start({ gatewayUrl: gw.url })
			.then((s) => s.run("hi"));
		const cost = gw.trace.requests[0].costUsd!;
		expect(cost).toBeGreaterThan(0);
		expect(gw.trace).toStayWithin({ usd: cost });
		expect(() => expect(gw.trace).toStayWithin({ usd: cost / 2 })).toThrow(/budget exceeded \(estimated\): usd/);
	});

	it("stops answering once the spend reaches maxUsd", async () => {
		const gw = await gateway({
			responder: script([call("search", { query: "again" })]),
			caps: { pricing, maxUsd: 0.2 },
		});
		const docs = mcp(gw, "docs", [searchTool]);
		const session = await referenceAdapter({ trace: gw.trace, mcp: [docs.client()], maxTurns: 50 }).start({
			gatewayUrl: gw.url,
		});
		const r = await session.run("loop");
		await session.close();
		const cut = gw.trace.of("cut");
		expect(cut).toHaveLength(1);
		expect(String(cut[0].data)).toMatch(/^budget cap \$0\.2 \(spent \$\d\.\d{4}\)$/);
		expect(r.answer).toBe("testkit: budget cap");
		// The cut request reached no model and costs nothing; the spend overshoots by at most the last answered request.
		const [answered, capped] = [gw.trace.requests.slice(0, -1), gw.trace.requests.at(-1)!];
		expect(capped.costUsd).toBeUndefined();
		const last = answered.at(-1)!.costUsd!;
		expect(spentUsd(gw.trace)).toBeGreaterThanOrEqual(0.2);
		expect(spentUsd(gw.trace) - last).toBeLessThan(0.2);
	});

	it("maxUsd without pricing fails at start", async () => {
		await expect(startGateway({ caps: { maxUsd: 1 } })).rejects.toThrow(/caps.maxUsd needs caps.pricing/);
	});
});
