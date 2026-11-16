import { describe, expect, it } from "vitest";
import { Trace, type CapturedRequest, type ChatMessage, type TraceEvent } from "../src/trace.ts";

type Ev = Omit<TraceEvent, "seq" | "span" | "agent"> & { agent?: string };

function req(messages: ChatMessage[], extra: Partial<CapturedRequest> = {}): CapturedRequest {
	return {
		index: 0,
		agent: "main",
		span: "main",
		model: "m",
		stream: false,
		messages,
		tools: [],
		raw: {},
		canonical: "",
		hash: "",
		bytes: JSON.stringify(messages).length,
		...extra,
	};
}

function trace(
	events: Ev[] = [],
	requests: CapturedRequest[] = [],
	spans: { id: string; role: string; parent?: string; reported?: boolean }[] = [],
): Trace {
	const t = new Trace();
	events.forEach((e) => t.record({ span: "main", agent: "main", ...e }));
	requests.forEach((r, i) => t.requests.push({ ...r, index: i }));
	spans.forEach((s) => t.addSpan({ reported: false, ...s }));
	return t;
}

const sys = (s: string): ChatMessage => ({ role: "system", content: s });
const user = (s: string): ChatMessage => ({ role: "user", content: s });
const call = (name: string, args: unknown = {}): Ev => ({ kind: "model_tool_call", name, args });
const answer: Ev = { kind: "answer" };

/** Each row is a trace on which the matcher must NOT pass: either it observed a violation or it cannot observe. */
const cases: { name: string; run: (t: Trace) => void; t: Trace; error: RegExp }[] = [
	// cannot observe
	{ name: "any matcher: not a trace", run: () => expect({}).toHaveCompacted(), t: trace(), error: /not a Trace/ },
	{
		name: "any matcher: empty trace",
		run: (t) => expect(t).toHaveCompacted(),
		t: trace(),
		error: /cannot observe: empty trace/,
	},
	{
		name: "toHaveCalledMcp: no events of that server",
		run: (t) => expect(t).toHaveCalledMcp("docs", "search"),
		t: trace([call("search")]),
		error: /cannot observe: no events from MCP server docs/,
	},
	{
		name: "toHaveCalledTool before: no such limit",
		run: (t) => expect(t).toHaveCalledTool("a", { before: "b" }),
		t: trace([call("a")]),
		error: /cannot observe: no call of b/,
	},
	{
		name: "toHaveLoadedSkill: no events",
		run: (t) => expect(t).toHaveLoadedSkill("x"),
		t: trace([], [req([user("x")])]),
		error: /cannot observe: no events/,
	},
	{
		name: "toKeepStablePrefix: one request",
		run: (t) => expect(t).toKeepStablePrefix(),
		t: trace([], [req([sys("a")])]),
		error: /cannot observe: need at least two requests/,
	},
	{
		name: "toHaveNoDuplicateBlocks: no requests",
		run: (t) => expect(t).toHaveNoDuplicateBlocks(),
		t: trace([answer]),
		error: /cannot observe: no requests/,
	},
	{
		name: "toGrowAtMost: one request per agent",
		run: (t) => expect(t).toGrowAtMost(10),
		t: trace([], [req([sys("a")])]),
		error: /cannot observe: need two requests/,
	},
	{
		name: "toHaveCacheReadRatio: no usage",
		run: (t) => expect(t).toHaveCacheReadRatio({ min: 0.1 }),
		t: trace([], [req([sys("a")])]),
		error: /cannot observe: no usage/,
	},
	{
		name: "toNotRetryIdentically: zero calls and errors",
		run: (t) => expect(t).toNotRetryIdentically("search"),
		t: trace([answer]),
		error: /cannot observe: no tool_error for search/,
	},
	{
		name: "toNotRetryIdentically: errors but no model calls",
		run: (t) => expect(t).toNotRetryIdentically("search"),
		t: trace([{ kind: "tool_error", name: "search", server: "docs" }]),
		error: /cannot observe: no model tool calls/,
	},
	{
		name: "toNotRetryIdentically: error without the preceding call",
		run: (t) => expect(t).toNotRetryIdentically("search"),
		t: trace([call("other"), { kind: "tool_error", name: "search" }]),
		error: /cannot observe: no model call of search before/,
	},
	{
		name: "toReflect: no tool_error",
		run: (t) => expect(t).toReflect({ after: "error" }),
		t: trace([call("a"), answer]),
		error: /cannot observe: no tool_error/,
	},
	{
		name: "toReflect: nothing after the error",
		run: (t) => expect(t).toReflect({ after: "error" }),
		t: trace([call("a"), { kind: "tool_error", name: "a" }]),
		error: /cannot observe: no model action after/,
	},
	{
		name: "toHaveSpawned: no spawn events or spans",
		run: (t) => expect(t).toHaveSpawned("coder"),
		t: trace([call("a"), answer]),
		error: /cannot observe: no spawn events/,
	},
	{
		name: "toHaveNoOrphanAgents: no child spans",
		run: (t) => expect(t).toHaveNoOrphanAgents(),
		t: trace([answer], [], [{ id: "main", role: "main" }]),
		error: /cannot observe: no child spans/,
	},
	{
		name: "toHaveHandedOff: no spawn events",
		run: (t) => expect(t).toHaveHandedOff("main", "coder"),
		t: trace([answer]),
		error: /cannot observe: no spawn events/,
	},
	{
		name: "toHaveRecalledBefore: no memory events",
		run: (t) => expect(t).toHaveRecalledBefore("k", "search"),
		t: trace([call("search")]),
		error: /cannot observe: no memory events/,
	},
	{
		name: "toHaveRecalledBefore: tool never called",
		run: (t) => expect(t).toHaveRecalledBefore("k", "search"),
		t: trace([{ kind: "memory_read", name: "k" }]),
		error: /cannot observe: search was never called/,
	},
	// the matcher sees data and the assertion is violated
	{
		name: "toHaveCalledTool: not called",
		run: (t) => expect(t).toHaveCalledTool("b"),
		t: trace([call("a")]),
		error: /expected tool b to be called/,
	},
	{
		name: "toHaveCalledTool: wrong times",
		run: (t) => expect(t).toHaveCalledTool("a", { times: 2 }),
		t: trace([call("a")]),
		error: /2 time\(s\), saw 1/,
	},
	{
		name: "toHaveCalledTool: args differ",
		run: (t) => expect(t).toHaveCalledTool("a", { args: { q: 1 } }),
		t: trace([call("a", { q: 2 })]),
		error: /to be called with/,
	},
	{
		name: "toHaveCalledTool: after the limit",
		run: (t) => expect(t).toHaveCalledTool("a", { before: "b" }),
		t: trace([call("b"), call("a")]),
		error: /before b/,
	},
	{
		name: "toHaveCalledMcp: tool not executed",
		run: (t) => expect(t).toHaveCalledMcp("docs", "search"),
		t: trace([{ kind: "tool_exec", name: "other", server: "docs" }]),
		error: /mcp docs\.search/,
	},
	{
		name: "toHaveLoadedSkill: other skill loaded",
		run: (t) => expect(t).toHaveLoadedSkill("a"),
		t: trace([{ kind: "skill_load", name: "b" }]),
		error: /expected skill a to load/,
	},
	{
		name: "toKeepStablePrefix: system rewritten",
		run: (t) => expect(t).toKeepStablePrefix(),
		t: trace([], [req([sys("a")]), req([sys("b"), user("x")])]),
		error: /prefix not stable/,
	},
	{
		name: "toHaveNoDuplicateBlocks: repeated block",
		run: (t) => expect(t).toHaveNoDuplicateBlocks({ minChars: 10 }),
		t: trace([], [req([user("same long block of text"), { role: "tool", content: "same long block of text" }])]),
		error: /duplicate blocks/,
	},
	{
		name: "toGrowAtMost: grows too fast",
		run: (t) => expect(t).toGrowAtMost(5),
		t: trace([], [req([sys("a")]), req([sys("a"), user("a".repeat(200))])]),
		error: /grew \d+ bytes/,
	},
	{
		name: "toHaveCacheReadRatio: below min",
		run: (t) => expect(t).toHaveCacheReadRatio({ min: 0.5 }),
		t: trace(
			[],
			[req([sys("a")], { usage: { promptTokens: 100, cachedTokens: 0, completionTokens: 1, estimated: false } })],
		),
		error: /cache read ratio 0\.000/,
	},
	{
		name: "toNotRetryIdentically: raw tool, same args",
		run: (t) => expect(t).toNotRetryIdentically("search"),
		t: trace([call("search", { q: 1 }), { kind: "tool_error", name: "search" }, call("search", { q: 1 })]),
		error: /retried with identical args/,
	},
	{
		name: "toNotRetryIdentically: namespaced model calls paired with server-side error",
		run: (t) => expect(t).toNotRetryIdentically("search"),
		t: trace([
			call("mcp__docs__search", { q: 1 }),
			{ kind: "tool_error", name: "search", server: "docs" },
			call("mcp__docs__search", { q: 1 }),
		]),
		error: /retried with identical args/,
	},
	{
		name: "toNotRetryIdentically: namespaced tool argument",
		run: (t) => expect(t).toNotRetryIdentically("mcp__docs__search"),
		t: trace([
			call("mcp__docs__search", { q: 1 }),
			{ kind: "tool_error", name: "search", server: "docs" },
			call("mcp__docs__search", { q: 1 }),
		]),
		error: /retried with identical args/,
	},
	{
		name: "toReflect: answers right after the error",
		run: (t) => expect(t).toReflect({ after: "error" }),
		t: trace([call("a"), { kind: "tool_error", name: "a" }, answer]),
		error: /without another tool call/,
	},
	{
		name: "toHaveSpawned: other role",
		run: (t) => expect(t).toHaveSpawned("coder"),
		t: trace([{ kind: "spawn", name: "tester" }]),
		error: /expected coder spawned at least once, saw 0/,
	},
	{
		name: "toHaveSpawned: wrong times",
		run: (t) => expect(t).toHaveSpawned("coder", { times: 2 }),
		t: trace([{ kind: "spawn", name: "coder" }]),
		error: /spawned 2, saw 1/,
	},
	{
		name: "toHaveNoOrphanAgents: child never reported",
		run: (t) => expect(t).toHaveNoOrphanAgents(),
		t: trace([answer], [], [{ id: "c", role: "coder", parent: "main" }]),
		error: /orphan agents/,
	},
	{
		name: "toHaveHandedOff: child never reports back",
		run: (t) => expect(t).toHaveHandedOff("main", "coder"),
		t: trace([{ kind: "spawn", name: "coder" }]),
		error: /never reported back/,
	},
	{
		name: "toHaveHandedOff: other child spawned",
		run: (t) => expect(t).toHaveHandedOff("main", "coder"),
		t: trace([{ kind: "spawn", name: "tester" }]),
		error: /never spawned coder/,
	},
	{
		name: "toHaveRecalledBefore: read after the action",
		run: (t) => expect(t).toHaveRecalledBefore("k", "search"),
		t: trace([call("search"), { kind: "memory_read", name: "k" }]),
		error: /but search ran/,
	},
	{
		name: "toHaveCompacted: requests but no compaction",
		run: (t) => expect(t).toHaveCompacted(),
		t: trace([answer]),
		error: /saw none/,
	},
];

describe("matchers fail when they cannot observe or the assertion is violated", () => {
	it.each(cases)("$name", ({ run, t, error }) => {
		expect(() => run(t)).toThrow(error);
	});

	it("cannot observe also throws under .not (no silent pass)", () => {
		expect(() => expect(trace([answer])).not.toHaveSpawned("coder")).toThrow(/cannot observe/);
		expect(() => expect(trace()).not.toHaveLoadedSkill("x")).toThrow(/cannot observe/);
	});

	it("every matcher has at least one negative case", async () => {
		const { matchers } = await import("../src/matchers.ts");
		const covered = new Set(cases.map((c) => /^(to\w+):/.exec(c.name)?.[1]));
		const missing = Object.keys(matchers).filter((m) => !covered.has(m));
		expect(missing).toEqual([]);
	});
});

describe("positive controls (the negative rows would be vacuous if these failed)", () => {
	it("toNotRetryIdentically passes when args change after a namespaced error", () => {
		const t = trace([
			call("mcp__docs__search", { q: 1 }),
			{ kind: "tool_error", name: "search", server: "docs" },
			call("mcp__docs__search", { q: 2 }),
		]);
		expect(t).toNotRetryIdentically("search");
	});

	it("toHaveSpawned passes with a spawn event", () => {
		expect(trace([{ kind: "spawn", name: "coder" }])).toHaveSpawned("coder");
	});
});
