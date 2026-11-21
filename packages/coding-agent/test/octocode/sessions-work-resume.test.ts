import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentRuns } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { latestRequest } from "../../src/octocode/sessions/brief.ts";
import { danglingChildren, unansweredCalls, unreportedWork } from "../../src/octocode/sessions/work.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";

const start = (call: string, runId?: string) => [
	{
		type: "message",
		timestamp: "2026-10-28T12:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: call, name: "agent", arguments: { type: "task", goal: call } }],
		},
	},
	{
		type: "message",
		timestamp: "2026-10-28T12:00:00Z",
		message: {
			role: "toolResult",
			toolName: "agent",
			toolCallId: call,
			details: { id: "general-worker", status: "background", ...(runId ? { runId } : {}) },
		},
	},
];
const report = (runId?: string) => ({
	type: "custom_message",
	customType: "octocode-agent-result",
	details: { id: "general-worker", ...(runId ? { runId } : {}) },
});

describe("background continuations of one child", () => {
	it("a previous report does not hide a later launch", () => {
		const entries = [...start("first", "first"), report("first"), ...start("second", "second")];
		expect(unreportedWork(entries)).toMatchObject([{ id: "general-worker", label: "second" }]);
		expect(unreportedWork(entries, Date.parse("2026-10-28T00:00:00Z"))).toHaveLength(1);
		expect(unreportedWork([...entries, report("second")])).toEqual([]);
	});

	it("a delayed old report cannot acknowledge the newer generation", () => {
		const entries = [...start("first", "run-1"), ...start("second", "run-2"), report("run-1")];
		expect(unreportedWork(entries)).toMatchObject([{ label: "second" }]);
		expect(unreportedWork([...entries, report("run-2")])).toEqual([]);
	});
});

describe("tool calls with no recorded result, on resume", () => {
	const call = (id: string, command: string) => ({
		type: "toolCall",
		id,
		name: "bash",
		arguments: { command },
	});
	const assistant = (content: unknown[], stopReason = "toolUse") => ({
		type: "message",
		message: { role: "assistant", content, stopReason },
	});
	const result = (id: string) => ({ type: "message", message: { role: "toolResult", toolCallId: id } });
	const user = { type: "message", message: { role: "user", content: "next" } };

	it("names the latest message's calls that have no result", () => {
		const entries = [assistant([call("a", "git push"), call("b", "rm build")]), result("b")];
		expect(unansweredCalls(entries)).toEqual(['bash({"command":"git push"})']);
		expect(unansweredCalls([...entries, result("a")])).toEqual([]);
	});

	it("ignores calls a later message moved past, and a reply the model never sees", () => {
		expect(unansweredCalls([assistant([call("a", "x")]), user])).toEqual([]);
		expect(unansweredCalls([assistant([call("a", "x")]), assistant([{ type: "text", text: "done" }], "stop")])).toEqual(
			[],
		);
		expect(unansweredCalls([assistant([call("a", "x")], "aborted")])).toEqual([]);
		expect(unansweredCalls([assistant([call("a", "x")], "error")])).toEqual([]);
		expect(unansweredCalls([])).toEqual([]);
	});
});

describe("the resume note's unanswered calls and last request", () => {
	it("keeps a long call's arguments and a long request whole", () => {
		const command = `echo ${"x".repeat(1_000)}`;
		const entries = [
			{ type: "message", message: { role: "user", content: `please ${"y".repeat(1_000)} done` } },
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command } }],
				},
			},
		];
		expect(unansweredCalls(entries)).toEqual([`bash(${JSON.stringify({ command })})`]);
		expect(latestRequest(entries)).toBe(`please ${"y".repeat(1_000)} done`);
	});

	it("names the children a dangling agent call started and how each ended", () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-children-")));
		vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
		vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
		const db = openAgentDb();
		const store = TeamStore.open(root, db.file);
		try {
			const ws = store.workspaceId;
			const at = Date.parse("2026-11-11T10:00:00Z");
			agentRuns.begin(
				db.db,
				{ workspaceId: ws, agentId: "general-old", parentSessionId: "s1", goal: "earlier" },
				at - 1,
			);
			agentRuns.begin(
				db.db,
				{ workspaceId: ws, agentId: "general-a", parentSessionId: "s1", goal: "child C1" },
				at + 1,
			);
			agentRuns.begin(
				db.db,
				{ workspaceId: ws, agentId: "general-b", parentSessionId: "s1", goal: "child C2" },
				at + 2,
			);
			agentRuns.begin(
				db.db,
				{ workspaceId: ws, agentId: "general-x", parentSessionId: "other", goal: "elsewhere" },
				at + 3,
			);
			agentRuns.finish(db.db, "general-a", { endReason: "left", endDetail: "parent exited" }, at + 10);
			const entries = [
				{
					type: "message",
					timestamp: "2026-11-11T10:00:00Z",
					message: {
						role: "assistant",
						stopReason: "toolUse",
						timestamp: at,
						content: [{ type: "toolCall", id: "c", name: "agent", arguments: { type: "task", tasks: [] } }],
					},
				},
			];
			expect(danglingChildren(db, "s1", entries)).toEqual([
				'general-a (goal "child C1"), ended: left (parent exited)',
				'general-b (goal "child C2"), no end recorded',
			]);
			// No unanswered `agent` call: no children to name.
			expect(
				danglingChildren(db, "s1", [...entries, { type: "message", message: { role: "toolResult", toolCallId: "c" } }]),
			).toEqual([]);
		} finally {
			store.close();
			db.close();
			vi.unstubAllEnvs();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
