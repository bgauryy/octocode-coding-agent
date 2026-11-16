import { describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { scripts } from "../src/gateway.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

const spawn = { toolCalls: [{ name: "spawn_agent", args: { role: "coder", task: "write it" } }] };

describe("multi-agent flows", () => {
	it("planner spawns coder and the report comes back", async () => {
		const gw = await gateway({
			responder: scripts({ main: [spawn, { text: "all done" }], coder: [{ text: "code written" }] }),
		});
		const r = await runInproc({ gatewayUrl: gw.url, trace: gw.trace }, "build");
		expect(r.answer).toBe("all done");
		expect(gw.trace).toHaveSpawned("coder", { times: 1 });
		expect(gw.trace).toHaveHandedOff("main", "coder");
		expect(gw.trace).toHaveNoOrphanAgents();
		expect(
			JSON.stringify(gw.trace.requests.find((q) => q.agent === "main" && q.messages.length > 2)!.messages),
		).toContain("code written");
		expect(gw.trace.agent("coder").requests).toHaveLength(1);
	});

	it("a child that never answers is an orphan", async () => {
		const loopForever = { toolCalls: [{ name: "search", args: { query: "again" } }] };
		const gw = await gateway({
			responder: scripts({ main: [spawn, { text: "gave up waiting" }], coder: [loopForever] }),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()], childMaxTurns: 2 }, "build");
		expect(() => expect(gw.trace).toHaveNoOrphanAgents()).toThrow(/coder#1/);
		expect(() => expect(gw.trace).toHaveHandedOff("main", "coder")).toThrow(/never reported/);
	});

	it("never spawned fails the handoff matcher", async () => {
		const gw = await gateway({ responder: scripts({ main: [{ text: "alone" }] }) });
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace }, "x");
		expect(() => expect(gw.trace).toHaveHandedOff("main", "coder")).toThrow(/cannot observe: no spawn events/);
	});
});
