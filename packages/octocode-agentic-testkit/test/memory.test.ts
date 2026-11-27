import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { MemoryStore } from "../src/memory.ts";
import { script } from "../src/gateway.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

describe("memory", () => {
	it("short memory is the message history", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "search", args: { query: "fact" } }] }, { text: "a" }]),
		});
		const docs = mcp(gw, "docs", [{ ...searchTool, handler: () => "SECRET-FACT-7" }]);
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()] }, "go");
		expect(JSON.stringify(gw.trace.requests[1].messages)).toContain("SECRET-FACT-7");
	});

	it("long memory survives runs: run 2 recalls the stored fact before acting", async () => {
		const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "tk-mem-")), "mem.json"));
		const gw1 = await gateway({
			responder: script([
				{ toolCalls: [{ name: "memory_write", args: { key: "deploy", value: "blue-green" } }] },
				{ text: "saved" },
			]),
		});
		await runInproc({ gatewayUrl: gw1.url, trace: gw1.trace, memory: store }, "remember");
		expect(gw1.trace.of("memory_write")[0].name).toBe("deploy");

		const gw2 = await gateway({
			responder: script([
				{ toolCalls: [{ name: "memory_read", args: { key: "deploy" } }] },
				{ toolCalls: [{ name: "search", args: { query: "deploy" } }] },
				{ text: "ok" },
			]),
		});
		const docs = mcp(gw2, "docs", [searchTool]);
		await runInproc({ gatewayUrl: gw2.url, trace: gw2.trace, memory: store, mcp: [docs.client()] }, "deploy");
		expect(JSON.stringify(gw2.trace.requests[1].messages)).toContain("blue-green");
		expect(gw2.trace).toHaveRecalledBefore("deploy", "search");
	});

	it("flags acting without recalling", async () => {
		const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "tk-mem-")), "mem.json"));
		const gw = await gateway({
			responder: script([
				{ toolCalls: [{ name: "memory_write", args: { key: "other", value: "v" } }] },
				{ toolCalls: [{ name: "search", args: { query: "x" } }] },
				{ text: "ok" },
			]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, memory: store, mcp: [docs.client()] }, "go");
		expect(() => expect(gw.trace).toHaveRecalledBefore("deploy", "search")).toThrow(/never read/);
	});

	it("cannot observe recall when the agent produced no memory events", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "search", args: { query: "x" } }] }, { text: "ok" }]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()] }, "go");
		expect(() => expect(gw.trace).toHaveRecalledBefore("deploy", "search")).toThrow(/cannot observe: no memory events/);
	});
});
