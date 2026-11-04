import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cacheHitRate,
	classifyCall,
	combineSummaries,
	multiCallTurnShare,
	octocodeShare,
	summarizeTranscript,
} from "../lib/transcript.mjs";

const usage = (cost, cacheRead = 90) => ({ input: 10, cacheRead, cacheWrite: 0, output: 5, cost: { total: cost } });
const call = (name, args = {}) => ({ type: "toolCall", id: "x", name, arguments: args });
const assistant = (content, extra = {}) => ({
	type: "message",
	message: { role: "assistant", model: "m1", stopReason: "toolUse", content, usage: usage(0.5), ...extra },
});
const jsonl = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");

test("classifies tool calls the way the measurement scripts do", () => {
	assert.equal(classifyCall("mcp__octocode__localFetch", {}), "octocode");
	assert.equal(classifyCall("bash", { command: "rg foo src" }), "bashRead");
	assert.equal(classifyCall("bash", { command: "cd /x && cat a.ts" }), "bashRead");
	assert.equal(classifyCall("bash", { command: "yarn test" }), "bashOther");
	assert.equal(classifyCall("bash", {}), "bashOther");
	assert.equal(classifyCall("file", {}), "file");
	assert.equal(classifyCall("agent", {}), "delegate");
	assert.equal(classifyCall("skill", {}), "skill");
	assert.equal(classifyCall("web", {}), "other");
});

test("summarizes requests, turns, cost, tool classes and the last answer", () => {
	const summary = summarizeTranscript(
		jsonl(
			{ type: "session", id: "s" },
			{ type: "custom", data: { usage: { cost: { total: 99 } } } },
			{ type: "message", message: { role: "user", content: "question" } },
			assistant([
				{ type: "thinking", thinking: "hm" },
				call("mcp__octocode__localSearch"),
				call("bash", { command: "grep x y" }),
			]),
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ignored" }] } },
			assistant([{ type: "text", text: "looking" }, call("skill", { name: "octocode-research" })]),
			assistant([{ type: "text", text: "final answer" }], { stopReason: "stop" }),
		),
	);
	assert.equal(summary.requests, 3);
	assert.equal(summary.turns, 2);
	assert.equal(summary.multiCallTurns, 1);
	assert.equal(summary.toolCalls, 3);
	assert.equal(summary.cost, 1.5);
	assert.equal(summary.tools.octocode, 1);
	assert.equal(summary.tools.bashRead, 1);
	assert.equal(summary.tools.skill, 1);
	assert.deepEqual(summary.skillLoads, ["octocode-research"]);
	assert.deepEqual(summary.models, { m1: 3 });
	assert.equal(summary.finalText, "final answer");
	assert.equal(summary.lastStopReason, "stop");
	assert.equal(summary.role, undefined);
	assert.equal(octocodeShare(summary), 0.5);
	assert.equal(multiCallTurnShare(summary), 0.5);
	assert.equal(cacheHitRate(summary), 0.9);
});

test("reads a child's name and role from its first message only", () => {
	const summary = summarizeTranscript(
		jsonl(
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "## You\nYour name is `brisk-otter` (researcher). You work for `main`." }],
				},
			},
			{ type: "message", message: { role: "user", content: "Your name is `other` (reviewer)." } },
		),
	);
	assert.equal(summary.childName, "brisk-otter");
	assert.equal(summary.role, "researcher");
	const general = summarizeTranscript(
		jsonl({ type: "message", message: { role: "user", content: "Your name is `x`. You work for `y`." } }),
	);
	assert.equal(general.role, "general");
});

test("counts side requests that the transcript records outside messages", () => {
	const summary = summarizeTranscript(
		jsonl(
			{ type: "usage", kind: "cache_warm", usage: usage(0.25) },
			{ type: "compaction", summary: "s", usage: usage(0.25) },
			{ type: "compaction", summary: "no usage recorded" },
			{ type: "branch_summary", summary: "s", usage: usage(0.5) },
		),
	);
	assert.equal(summary.requests, 0);
	assert.equal(summary.sideRequests, 3);
	assert.equal(summary.cost, 1);
});

test("survives a torn line, a request without cost and an aborted request", () => {
	const summary = summarizeTranscript(
		[
			JSON.stringify(assistant([{ type: "text", text: "ok" }])),
			JSON.stringify(assistant([], { usage: { input: 1, output: 1 }, stopReason: "aborted", errorMessage: "boom" })),
			'{"type":"message","mess',
		].join("\n"),
	);
	assert.equal(summary.malformedLines, 1);
	assert.equal(summary.missingCost, 1);
	assert.equal(summary.lastStopReason, "aborted");
	assert.equal(summary.errorMessage, "boom");
	assert.equal(summary.finalText, "ok");
});

test("flags a tool call that names the eval kit", () => {
	const summary = summarizeTranscript(
		jsonl(assistant([call("bash", { command: "cat scripts/agent-eval/tasks.json" })])),
	);
	assert.equal(summary.leakCalls, 1);
});

test("shares are null when the run gave them no denominator", () => {
	const empty = summarizeTranscript("");
	assert.equal(octocodeShare(empty), null);
	assert.equal(multiCallTurnShare(empty), null);
	assert.equal(cacheHitRate(empty), null);
});

test("combines main and child summaries", () => {
	const main = summarizeTranscript(jsonl(assistant([call("mcp__octocode__localFetch")])));
	const child = summarizeTranscript(
		jsonl(assistant([call("bash", { command: "ls" }), call("bash", { command: "cat a" })], { model: "m2" })),
	);
	const total = combineSummaries([main, child]);
	assert.equal(total.requests, 2);
	assert.equal(total.cost, 1);
	assert.equal(total.tools.octocode, 1);
	assert.equal(total.tools.bashRead, 2);
	assert.deepEqual(total.models, { m1: 1, m2: 1 });
	assert.equal(total.multiCallTurns, 1);
	assert.equal(total.tokens.cacheRead, 180);
});
