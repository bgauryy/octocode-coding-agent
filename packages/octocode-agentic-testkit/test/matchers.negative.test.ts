import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "../src/matchers/answer.ts";
import { analyzeSurface } from "../src/surface.ts";
import { Trace, type CapturedRequest, type ChatMessage, type TraceEvent } from "../src/trace.ts";
import { diffWorkspace, snapshotWorkspace, type VerifierResult } from "../src/workspace.ts";

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

function observed(t: Trace): Trace {
	t.observe("events");
	return t;
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
const cold = { promptTokens: 2000, cachedTokens: 0, completionTokens: 1, estimated: false };
/** A Standard Schema that accepts any value: the rows below fail before validation. */
const anySchema: StandardSchemaV1 = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) } };

/** Runs `fn` on a fresh directory holding `a.txt`, then removes it. */
function inTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "testkit-negative-"));
	try {
		writeFileSync(join(dir, "a.txt"), "1");
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const failedVerifier: VerifierResult = {
	pass: false,
	exitCode: 1,
	timedOut: false,
	stdout: "",
	stderr: "1 test failed",
};

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
		name: "toHaveSpawned: no event probe",
		run: (t) => expect(t).toHaveSpawned("coder"),
		t: trace([call("a"), answer]),
		error: /cannot observe: no event probe/,
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
		name: "toHaveCalledTool: another ISO date in args (dates are not masked)",
		run: (t) => expect(t).toHaveCalledTool("schedule", { args: { date: "2026-11-18" } }),
		t: trace([call("schedule", { date: "1999-01-01" })]),
		error: /to be called with/,
	},
	{
		name: "toHaveCalledTool: another call id in args",
		run: (t) => expect(t).toHaveCalledTool("cancel", { args: { ref: "call_abc12345" } }),
		t: trace([call("cancel", { ref: "toolu_zzz99999" })]),
		error: /to be called with/,
	},
	{
		name: "toHaveCalledTool: another secret-shaped value in args",
		run: (t) => expect(t).toHaveCalledTool("login", { args: { token: "sk-aaaaaaaaaaaaaaaa" } }),
		t: trace([call("login", { token: "sk-bbbbbbbbbbbbbbbb" })]),
		error: /to be called with/,
	},
	{
		name: "toHaveCalledTool: times holds but the call came after the answer",
		run: (t) => expect(t).toHaveCalledTool("search", { times: 1, before: "answer" }),
		t: trace([answer, call("search")]),
		error: /1 time\(s\) before an answer by the same agent; calls not before it: #1/,
	},
	{
		name: "toHaveCalledTool: times holds but the call came after the limit tool",
		run: (t) => expect(t).toHaveCalledTool("a", { times: 1, before: "b" }),
		t: trace([call("b"), call("a")]),
		error: /before b \(event #0\)/,
	},
	{
		name: "toHaveCalledTool: times with before, one counted call too late",
		run: (t) => expect(t).toHaveCalledTool("search", { times: 2, before: "answer" }),
		t: trace([call("search"), answer, call("search")]),
		error: /calls not before it: #2/,
	},
	{
		name: "toHaveCalledTool: before answer, only a subagent answered after the call",
		run: (t) => expect(t).toHaveCalledTool("fetch", { before: "answer" }),
		t: trace([answer, call("fetch"), { kind: "answer", agent: "coder" }]),
		error: /before an answer by the same agent/,
	},
	{
		name: "toHaveCalledTool: before answer, the subagent's call has no answer of its own",
		run: (t) => expect(t).toHaveCalledTool("fetch", { before: "answer" }),
		t: trace([{ ...call("fetch"), agent: "coder" }, answer]),
		error: /before an answer by the same agent/,
	},
	{
		name: "toHaveCalledTool before answer: no answer at all",
		run: (t) => expect(t).toHaveCalledTool("a", { before: "answer" }),
		t: trace([call("a")]),
		error: /cannot observe: no answer in the trace/,
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
		name: "toNotRetryIdentically: same args in another key order",
		run: (t) => expect(t).toNotRetryIdentically("search"),
		t: trace([call("search", { q: 1, n: 2 }), { kind: "tool_error", name: "search" }, call("search", { n: 2, q: 1 })]),
		error: /retried with identical args/,
	},
	{
		name: "toNotRetryIdentically: .not on a retry that changed only a date",
		run: (t) => expect(t).not.toNotRetryIdentically("schedule"),
		t: trace([
			call("schedule", { date: "1999-01-01" }),
			{ kind: "tool_error", name: "schedule" },
			call("schedule", { date: "2026-11-18" }),
		]),
		error: /expected schedule to be retried identically/,
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
		name: "toHaveCompacted: no event probe",
		run: (t) => expect(t).toHaveCompacted(),
		t: trace([call("a")]),
		error: /cannot observe: no event probe/,
	},
	{
		name: "toHaveCompacted: events observed but no compaction",
		run: (t) => expect(t).toHaveCompacted(),
		t: observed(trace([answer])),
		error: /saw none/,
	},
	{
		name: "toHaveLoadedSkill: name is only a prefix of the skill directory",
		run: (t) => expect(t).toHaveLoadedSkill("test"),
		t: trace([call("read", { path: "/s/test-runner/SKILL.md" })]),
		error: /expected skill test to load/,
	},
	{
		name: "toFollowTrajectory: no calls and no requests",
		run: (t) => expect(t).toFollowTrajectory(["a"]),
		t: trace([answer]),
		error: /cannot observe: no model tool calls/,
	},
	{
		name: "toFollowTrajectory: wrong order",
		run: (t) => expect(t).toFollowTrajectory(["a", "b"]),
		t: trace([call("b"), call("a")]),
		error: /trajectory does not match/,
	},
	{
		name: "toFollowTrajectory: exact args with another date",
		run: (t) => expect(t).toFollowTrajectory([{ tool: "schedule", args: { date: "2026-11-18" } }], { args: "exact" }),
		t: trace([call("schedule", { date: "1999-01-01" })]),
		error: /trajectory does not match/,
	},
	{
		name: "toFollowTrajectory: subset args with another call id",
		run: (t) => expect(t).toFollowTrajectory([{ tool: "cancel", args: { ref: "call_abc12345" } }]),
		t: trace([call("cancel", { ref: "call_zzz99999", why: "x" })]),
		error: /trajectory does not match/,
	},
	{
		name: "toStayWithin: token limit without usage",
		run: (t) => expect(t).toStayWithin({ promptTokens: 10 }),
		t: trace([], [req([sys("a")])]),
		error: /cannot observe: no usage/,
	},
	{
		name: "toStayWithin: too many requests",
		run: (t) => expect(t).toStayWithin({ requests: 1 }),
		t: trace([], [req([sys("a")]), req([sys("a")])]),
		error: /requests 2 > 1/,
	},
	{
		name: "toPassSurfaceReview: not a surface report",
		run: (t) => expect(t).toPassSurfaceReview(),
		t: trace([call("a")]),
		error: /cannot observe: received value is not a SurfaceReport/,
	},
	{
		name: "toPassSurfaceReview: an undocumented tool",
		run: () =>
			expect(analyzeSurface({ tools: [{ name: "x", inputSchema: { type: "object" } }] })).toPassSurfaceReview(),
		t: trace(),
		error: /description-missing x[\s\S]*open-object x/,
	},
	{
		name: "toMatchSchema: no answer in the trace",
		run: (t) => expect(t).toMatchSchema(anySchema),
		t: trace([call("a")]),
		error: /cannot observe: no answer in the trace/,
	},
	{
		name: "toMatchSchema: the answer holds no JSON",
		run: () => expect("plain words").toMatchSchema(anySchema),
		t: trace(),
		error: /no JSON value found/,
	},
	{
		name: "toKeepEnvelopesUnder: no requests",
		run: (t) => expect(t).toKeepEnvelopesUnder({ toolInputChars: 1 }),
		t: trace([call("a", { q: "long" })]),
		error: /cannot observe: no requests/,
	},
	{
		name: "toKeepEnvelopesUnder: a tool result over the limit",
		run: (t) => expect(t).toKeepEnvelopesUnder({ toolOutputChars: 3 }),
		t: trace(
			[],
			[
				req([
					{
						role: "assistant",
						tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
					},
					{ role: "tool", tool_call_id: "c1", content: "four" },
				]),
			],
		),
		error: /read \(main, c1\) returned 4 chars > 3/,
	},
	{
		name: "toKeepCacheWarm: no usage",
		run: (t) => expect(t).toKeepCacheWarm(),
		t: trace([], [req([sys("a")]), req([sys("a")])]),
		error: /cannot observe: no usage on any request/,
	},
	{
		name: "toKeepCacheWarm: a cold read after the first request",
		run: (t) => expect(t).toKeepCacheWarm(),
		t: trace([], [req([sys("a")], { usage: cold }), req([sys("a")], { usage: cold })]),
		error: /request 1 \(main\) read 0 of 2000 prompt tokens from cache/,
	},
	{
		name: "toStayWithin: a usd limit without priced requests",
		run: (t) => expect(t).toStayWithin({ usd: 1 }),
		t: trace([], [req([user("hi")])]),
		error: /cannot observe: no priced request/,
	},
	{
		name: "toStayWithin: over the usd limit",
		run: (t) => expect(t).toStayWithin({ usd: 0.01 }),
		t: trace([], [req([user("hi")], { costUsd: 0.02 })]),
		error: /usd 0\.020000 > 0\.01/,
	},
	{
		name: "toHaveBlocked: no guards on the trace",
		run: (t) => expect(t).not.toHaveBlocked(),
		t: trace([call("delete_repo")]),
		error: /cannot observe: no guards on this trace/,
	},
	{
		name: "toHaveBlocked: a guard blocked a different call",
		run: (t) => expect(t).toHaveBlocked("delete_*"),
		t: trace([{ kind: "guard", name: "search", data: { reason: "more than 1 tool calls" } }]),
		error: /expected a guard to block delete_\*; blocked: #0 search: more than 1 tool calls/,
	},
	{
		name: "toHaveWorkspace: an expected file is missing",
		run: () => inTempDir((dir) => expect(dir).toHaveWorkspace({ "a.txt": "1", "b.txt": "2" })),
		t: trace(),
		error: /the workspace does not match:\s+b\.txt: missing/,
	},
	{
		name: "toChangeOnly: a file added outside the globs",
		run: () =>
			inTempDir((dir) => {
				const before = snapshotWorkspace(dir);
				writeFileSync(join(dir, "evil.sh"), "rm -rf /");
				expect(diffWorkspace(before, snapshotWorkspace(dir))).toChangeOnly(["src/**", "a.txt"]);
			}),
		t: trace(),
		error: /changed outside .*\s+added evil\.sh/,
	},
	{
		name: "toPassVerifier: the verifier failed",
		run: () => expect(failedVerifier).toPassVerifier(),
		t: trace(),
		error: /the verifier failed \(exit 1\)[\s\S]*1 test failed/,
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

	it("an unobserved event kind throws under .not too, and passes once the probe is declared", () => {
		const t = trace([call("a")]);
		expect(() => expect(t).not.toHaveCompacted()).toThrow(/cannot observe: no event probe/);
		expect(() => expect(t).not.toHaveSpawned("x")).toThrow(/cannot observe: no event probe/);
		t.observe("events");
		expect(t).not.toHaveCompacted();
		expect(t).not.toHaveSpawned("x");
	});

	it("a Skill call fails .not.toHaveLoadedSkill", () => {
		const t = trace([call("Skill", { skill: "runbook" })]);
		expect(() => expect(t).not.toHaveLoadedSkill("runbook")).toThrow(/not to load/);
	});

	it("every matcher has at least one negative case", async () => {
		const { matchers } = await import("../src/matchers.ts");
		const covered = new Set(cases.map((c) => /^(to\w+):/.exec(c.name)?.[1]));
		const missing = Object.keys(matchers).filter((m) => !covered.has(m));
		expect(missing).toEqual([]);
	});
});

const SKILL = "/x/skills/runbook/SKILL.md";

/** Calls that change, delete or move the skill file: none of them loads the skill. */
const skillChanges: [string, Ev][] = [
	["Claude Edit", call("Edit", { file_path: SKILL, old_string: "a", new_string: "b" })],
	["Claude Write", call("Write", { file_path: SKILL, content: "x" })],
	["Claude MultiEdit", call("MultiEdit", { file_path: SKILL, edits: [] })],
	["octocodecode file edit", call("file", { queries: [{ type: "edit", path: SKILL, oldText: "a", newText: "b" }] })],
	["octocodecode file delete", call("file", { queries: [{ type: "delete", path: SKILL }] })],
	["text editor create", call("str_replace_based_edit_tool", { command: "create", path: SKILL, file_text: "x" })],
	[
		"apply_patch tool",
		call("apply_patch", { input: `*** Begin Patch\n*** Update File: ${SKILL}\n-a\n+b\n*** End Patch` }),
	],
	["delete_file", call("delete_file", { target_file: SKILL })],
	["move_file", call("move_file", { source: SKILL, destination: "/tmp/old.md" })],
	["Bash sed -i", call("Bash", { command: `sed -i 's/a/b/' ${SKILL}` })],
	["Bash rm", call("Bash", { command: `rm -f ${SKILL}` })],
	["Bash mv", call("Bash", { command: `mv ${SKILL} /tmp/SKILL.bak` })],
	["Bash tee", call("Bash", { command: `echo x | tee -a ${SKILL}` })],
	["Bash > redirect", call("Bash", { command: `echo x > ${SKILL}` })],
	["Bash >> redirect", call("Bash", { command: `printf 'x' >> "${SKILL}"` })],
	["Bash heredoc into the file", call("Bash", { command: `cat > ${SKILL} <<'EOF'\nnew body\nEOF` })],
	["Bash perl -pi", call("Bash", { command: `perl -pi -e 's/a/b/' ${SKILL}` })],
	["Codex argv rm", call("shell", { command: ["rm", SKILL] })],
	["Codex bash -lc sed -i", call("shell", { command: ["bash", "-lc", `sed -i.bak 's/a/b/' ${SKILL}`] })],
	[
		"Codex apply_patch heredoc",
		call("shell", {
			command: [
				"bash",
				"-lc",
				`apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: ${SKILL}\n-a; b\n*** End Patch\nEOF`,
			],
		}),
	],
	[
		"Codex argv apply_patch",
		call("shell", { command: ["apply_patch", `*** Begin Patch\n*** Update File: ${SKILL}\n*** End Patch`] }),
	],
	["git mv", call("Bash", { command: `git mv ${SKILL} /x/skills/runbook/OLD.md` })],
];

describe("changing the skill file is not loading the skill", () => {
	it.each(skillChanges)("%s", async (_label, ev) => {
		const t = trace([ev]);
		expect(() => expect(t).toHaveLoadedSkill("runbook")).toThrow(/expected skill runbook to load/);
		const { skillLoads } = await import("../src/matchers/skills.ts");
		expect(skillLoads(t)).toEqual([]);
	});

	it("a script that reads one skill and edits another loads only the one it read", async () => {
		const t = trace([call("Bash", { command: `cat /s/a/SKILL.md && sed -i 's/x/y/' /s/b/SKILL.md` })]);
		expect(t).toHaveLoadedSkill("a");
		expect(() => expect(t).toHaveLoadedSkill("b")).toThrow(/expected skill b to load/);
		const { skillLoads } = await import("../src/matchers/skills.ts");
		expect(skillLoads(t)).toEqual(["a"]);
	});
});

describe("positive controls (the negative rows would be vacuous if these failed)", () => {
	it("argument checks pass on the same date, call id and secret, in any key order", () => {
		const t = trace([call("schedule", { date: "2026-11-18", ref: "call_abc12345", token: "sk-aaaaaaaaaaaaaaaa" })]);
		expect(t).toHaveCalledTool("schedule", { args: { token: "sk-aaaaaaaaaaaaaaaa", date: "2026-11-18" } });
		expect(t).toFollowTrajectory(
			[{ tool: "schedule", args: { token: "sk-aaaaaaaaaaaaaaaa", ref: "call_abc12345", date: "2026-11-18" } }],
			{ args: "exact" },
		);
	});

	it("toNotRetryIdentically passes when a retry changed only a date", () => {
		const t = trace([
			call("schedule", { date: "1999-01-01" }),
			{ kind: "tool_error", name: "schedule" },
			call("schedule", { date: "2026-11-18" }),
		]);
		expect(t).toNotRetryIdentically("schedule");
	});

	it("times and before pass together when the counted calls come first, each agent answering for itself", () => {
		const t = trace([
			call("search"),
			{ ...call("fetch"), agent: "coder" },
			{ kind: "answer", agent: "coder" },
			call("search"),
			answer,
		]);
		expect(t).toHaveCalledTool("search", { times: 2, before: "answer" });
		expect(t).toHaveCalledTool("fetch", { times: 1, before: "answer" });
		expect(t).toHaveCalledTool("search", { before: "fetch" });
	});

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
