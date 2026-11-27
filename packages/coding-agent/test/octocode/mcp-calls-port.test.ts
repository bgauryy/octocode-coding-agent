import { tmp } from "./helpers.ts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMcpHost } from "../../../mcp/src/api.ts";
import { createMcpToolDefinition } from "../../../mcp/src/tool-definition.ts";
import type { McpClient } from "../../../mcp/src/client/index.ts";
import { asyncJobsFor } from "../../src/octocode/jobs/registry.ts";
import { taskReport } from "../../src/octocode/jobs/report.ts";
import type { JobOutcome } from "../../src/octocode/jobs/async-jobs.ts";
import { mcpCalls } from "../../src/octocode/mcp-host/calls.ts";
import { installMcpCorePorts } from "../../src/octocode/mcp-host/core.ts";
import { RunningWork } from "../../src/octocode/shared/running-work.ts";

const opened: object[] = [];

function session() {
	const sessionManager = {};
	opened.push(sessionManager);
	const reports: Array<{ id: string; outcome: JobOutcome }> = [];
	asyncJobsFor(sessionManager).attach({
		work: new RunningWork(),
		deliver: (job, outcome) => void reports.push({ id: job.id, outcome }),
		failed: (_job, error) => {
			throw error;
		},
	});
	return { ctx: { sessionManager } as never, reports, sessionManager };
}

function tool(callTool: McpClient["callTool"]) {
	return createMcpToolDefinition({
		server: "srv",
		tool: { name: "slow", description: "Slow work.", inputSchema: { type: "object" } },
		name: "mcp__srv__slow",
		exposure: "direct",
		namespace: { name: "mcp__srv" },
		timeoutMs: 60_000,
		getClient: async () => ({ callTool }),
	});
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => installMcpCorePorts());

afterEach(async () => {
	installMcpHost({ calls: undefined });
	for (const owner of opened.splice(0)) await asyncJobsFor(owner).stopAll("session end");
});

describe("MCP proxy calls on the host's jobs", () => {
	it("returns a fast call's own result", async () => {
		installMcpHost({ calls: mcpCalls(1000) });
		const { ctx, reports } = session();
		const reply = await tool(async () => ok("quick")).execute("id", {}, undefined, undefined, ctx);
		expect(reply.content).toEqual([{ type: "text", text: "quick" }]);
		expect(reports).toEqual([]);
	});

	it("returns a task id for a call past the budget and reports the server's answer to the session", async () => {
		installMcpHost({ calls: mcpCalls(10) });
		const { ctx, reports, sessionManager } = session();
		const reply = await tool(async () => {
			await sleep(60);
			return ok("slow answer");
		}).execute("id", { path: "x", reason: "index the repo" }, undefined, undefined, ctx);
		expect(reply.details).toMatchObject({ kind: "job-started", job: "task-1" });
		expect(reply.content[0]).toMatchObject({ text: expect.stringContaining("task-1") });
		await asyncJobsFor(sessionManager).settle();
		expect(reports).toHaveLength(1);
		const job = { id: "task-1", tool: "mcp__srv__slow", title: "x", startedAt: 0 };
		expect(await taskReport(job, reports[0].outcome, tmp)).toContain("slow answer");
	});

	it("names the call and its reason on the job", async () => {
		installMcpHost({ calls: mcpCalls(5) });
		const { ctx, sessionManager } = session();
		await tool(async () => {
			await sleep(40);
			return ok("done");
		}).execute("id", { path: "x", reason: "index the repo" }, undefined, undefined, ctx);
		const [job] = asyncJobsFor(sessionManager).running();
		expect(job).toMatchObject({ tool: "mcp__srv__slow", reason: "index the repo" });
		expect(job.title).toContain("srv/slow");
		await asyncJobsFor(sessionManager).settle();
	});

	it("aborts the server call when the job is stopped from the footer", async () => {
		installMcpHost({ calls: mcpCalls(5) });
		const { ctx, reports, sessionManager } = session();
		let serverSignal: AbortSignal | undefined;
		await tool((_name, _args, options) => {
			serverSignal = options?.signal;
			return new Promise(() => undefined);
		}).execute("id", {}, undefined, undefined, ctx);
		expect(asyncJobsFor(sessionManager).stop("task-1", "user")).toBe(true);
		expect(serverSignal?.aborted).toBe(true);
		expect(reports[0].outcome).toMatchObject({ kind: "stopped", by: "user" });
	});

	it("reports a server failure after the hand-over as a failed job", async () => {
		installMcpHost({ calls: mcpCalls(5) });
		const { ctx, reports, sessionManager } = session();
		await tool(async () => {
			await sleep(40);
			throw new Error("connection reset");
		}).execute("id", {}, undefined, undefined, ctx);
		await asyncJobsFor(sessionManager).settle();
		expect(reports[0].outcome).toMatchObject({ kind: "failed" });
	});

	it("runs a call without a session directly", async () => {
		installMcpHost({ calls: mcpCalls(1) });
		const reply = await tool(async () => {
			await sleep(30);
			return ok("waited");
		}).execute("id", {}, undefined, undefined, {} as never);
		expect(reply.content).toEqual([{ type: "text", text: "waited" }]);
	});
});
