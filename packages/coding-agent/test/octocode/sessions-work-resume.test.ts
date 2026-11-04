import { describe, expect, it } from "vitest";
import { unansweredCalls, unreportedWork } from "../../src/octocode/sessions/work.ts";

const start = (call: string, runId?: string) => [
	{
		type: "message",
		timestamp: "2026-10-28T12:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: call, name: "agent", arguments: { type: "task", input: { goal: call } } }],
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
	it("a previous report does not hide a later launch, including legacy records", () => {
		for (const runs of [
			[undefined, undefined],
			["first", "second"],
		]) {
			const entries = [...start("first", runs[0]), report(runs[0]), ...start("second", runs[1])];
			expect(unreportedWork(entries)).toMatchObject([{ id: "general-worker", label: "second" }]);
			expect(unreportedWork(entries, Date.parse("2026-10-28T00:00:00Z"))).toHaveLength(1);
			expect(unreportedWork([...entries, report(runs[1])])).toEqual([]);
		}
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
