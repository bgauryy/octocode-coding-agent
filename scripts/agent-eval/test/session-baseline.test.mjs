import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, sessions as sessionRows, transcripts } from "../../../packages/db/src/api.ts";
import { renderBaseline } from "../lib/session-baseline-report.mjs";
import {
	nearScore,
	roleToolCalls,
	sessionBaseline,
	startsWithOutcome,
	trigramSimilarity,
} from "../lib/session-baseline.mjs";
import { outputPath, readBaseline } from "../session-baseline.mjs";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const MIN = 60_000;
let nextId = 0;

/** One assistant request `minutes` after `T0`, with its usage and tool calls. */
function request(minutes, usage, calls = [], { provider = "anthropic", model = "model-a", text } = {}) {
	return {
		type: "message",
		id: `e${nextId++}`,
		timestamp: new Date(T0 + minutes * MIN).toISOString(),
		message: {
			role: "assistant",
			provider,
			model,
			timestamp: T0 + minutes * MIN,
			usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...usage },
			content: [
				...(text ? [{ type: "text", text }] : []),
				...calls.map(([name, args]) => ({ type: "toolCall", id: `c${nextId++}`, name, arguments: args })),
			],
		},
	};
}
const user = (text) => ({ type: "message", id: `e${nextId++}`, message: { role: "user", content: text } });

/** Three real sessions (a main that starts two children, a reviewer, a researcher), a main that starts none, and a scripted one. */
function fixture() {
	const sessions = {
		main: {
			header: { cwd: "/work/repo" },
			entries: [
				user("Please fix the permision prompt"),
				// First request: the whole prompt (1,000 tokens) is written, nothing read.
				request(0, { cacheWrite: 1000, cacheWrite1h: 1000, output: 100 }, [
					["bash", { command: "ls", reason: "x".repeat(40) }],
					["agent", { type: "task", tasks: [{ task: "a" }, { task: "b" }], reason: "y".repeat(40) }],
				]),
				// Second request, 10 minutes later: prefix read whole, 500 of 1,000 history tokens read.
				request(10, { input: 500, cacheRead: 1500, output: 100 }, [["agent", { type: "coordinate", action: "list" }]]),
			],
		},
		solo: {
			header: { cwd: "/work/repo" },
			entries: [
				user("Show the release notes"),
				request(0, { cacheWrite: 800, output: 50 }, [["agent", { type: "task", task: "c", resume: "x" }]]),
			],
		},
		reviewer: {
			header: { cwd: "/work/repo", parentSession: "main" },
			entries: [
				request(1, { cacheRead: 400, cacheWrite: 600, output: 20 }, [
					["mcp__octocode__localFetch", { reason: "read" }],
				]),
				request(2, { cacheRead: 1000, output: 30 }, [], { text: "## Findings\nnone" }),
			],
		},
		researcher: {
			header: { cwd: "/work/repo", parentSession: "main" },
			entries: [
				{
					type: "custom",
					customType: "octocode-subagent-identity",
					data: { text: "## You\nYour name is `calm-abyss` (researcher). Your goal: x" },
				},
				request(1, { cacheWrite: 500, output: 10 }, [["mcp__octocode__ghSearchCode", { reason: "find" }]]),
				request(70, { input: 500, output: 10 }, [], { text: "**Done.** Found it." }),
			],
		},
		scripted: {
			header: { cwd: "/work/repo" },
			entries: [request(0, { input: 10, output: 1 }, [["bash", {}]], { provider: "faux" })],
		},
		temporary: { header: { cwd: "/var/folders/ab/T/x" }, entries: [request(0, { input: 10, output: 1 })] },
	};
	return {
		sessions,
		headers: Object.entries(sessions).map(([sessionId, session]) => ({
			sessionId,
			header: JSON.stringify(session.header),
		})),
		entries: Object.entries(sessions).flatMap(([sessionId, session]) =>
			session.entries.map((entry) => ({ sessionId, data: JSON.stringify(entry) })),
		),
		runs: [
			{ kind: "main", sessionId: "main" },
			{ kind: "main", sessionId: "solo" },
			{
				kind: "child",
				profile: "reviewer",
				sessionId: "reviewer",
				parentSessionId: "main",
				endReason: "completed",
				outcome: "done",
				outcomeSource: "asked",
			},
			// The researcher's run row has no session: its role comes from the identity entry.
			{ kind: "child", profile: "researcher", parentSessionId: "main", endReason: "completed" },
		],
		memories: [
			{ title: "Permission asks stay short", keywords: "permission", body: "" },
			{ title: "Unrelated", keywords: "", body: "notes about nothing in particular" },
		],
	};
}

test("measures only real sessions outside temporary directories", () => {
	const { scope } = sessionBaseline(fixture());
	assert.deepEqual(scope, { sessions: 6, measured: 4, excluded: 2, requests: 7 });
});

test("splits each request's cache read into the instruction prefix first, then history", () => {
	const { cache } = sessionBaseline(fixture());
	const main = cache.find((row) => row.role === "main");
	// Both main sessions' first requests read nothing; `main`'s second reads its 1,000-token prefix and half its history.
	assert.equal(main.requests, 3);
	assert.deepEqual([main.instructions, main.instructionsRead], [2800, 1000]);
	assert.deepEqual([main.history, main.historyRead], [1000, 500]);
	assert.deepEqual([main.firstRequests, main.firstPrompt, main.firstRead], [2, 1800, 0]);
	const reviewer = cache.find((row) => row.role === "reviewer");
	assert.deepEqual(
		[reviewer.day, reviewer.prompt, reviewer.cacheRead, reviewer.firstRead],
		["2026-11-10", 2000, 1400, 400],
	);
});

test("counts request gaps past each cache tier and the tier of cache writes", () => {
	const { gaps } = sessionBaseline(fixture());
	const by = Object.fromEntries(gaps.map((row) => [row.role, row]));
	assert.deepEqual([by.main.gaps, by.main.overShort, by.main.overLong], [1, 1, 0]);
	assert.deepEqual([by.researcher.gaps, by.researcher.overShort, by.researcher.overLong], [1, 1, 1]);
	assert.deepEqual([by.reviewer.gaps, by.reviewer.overShort], [1, 0]);
	assert.deepEqual([by.main.cacheWrite, by.main.cacheWrite1h], [1800, 1000]);
});

test("counts tool calls per role, taking a child's role from its run or its identity entry", () => {
	const baseline = sessionBaseline(fixture());
	const tools = ["mcp__octocode__ghSearchCode", "mcp__octocode__localFetch"];
	assert.deepEqual(roleToolCalls(baseline, "reviewer", tools), {
		sessions: 1,
		calls: [
			["mcp__octocode__ghSearchCode", 0],
			["mcp__octocode__localFetch", 1],
		],
	});
	assert.deepEqual(roleToolCalls(baseline, "researcher", tools).calls[0], ["mcp__octocode__ghSearchCode", 1]);
	// No session of a role is no evidence, and reads as zero sessions.
	assert.equal(roleToolCalls(baseline, "general", tools).sessions, 0);
});

test("counts the children a main session starts: task lists count each task, resumes and coordination none", () => {
	const { children } = sessionBaseline(fixture());
	assert.deepEqual(children, { mainSessions: 2, none: 1, one: 0, twoOrMore: 1, runsOne: 0, runsTwoOrMore: 1 });
});

test("estimates the output tokens spent on reason from the stored argument text", () => {
	const { reason } = sessionBaseline(fixture());
	const main = reason.byRole.find((row) => row.role === "main");
	// 4 calls, 2 with a 40-character reason: 80 / 4 + 2 * 4 key tokens.
	assert.deepEqual([main.calls, main.withReason, main.chars, main.tokens, main.output], [4, 2, 80, 28, 250]);
	assert.equal(reason.total.withReason, 4);
});

test("finds reports whose first word is not an outcome word", () => {
	const { reports } = sessionBaseline(fixture());
	assert.deepEqual([reports.reports, reports.miss], [2, 1]);
	assert.deepEqual(reports.runs, { completed: 2, first: 0, otherSource: 1, unrecorded: 1 });
	assert.equal(startsWithOutcome("**Report: partial.** the rest"), true);
	assert.equal(startsWithOutcome("Summary: done"), false);
});

test("replays first prompts against memories: an exact word is a hit, a misspelt one only a near match", () => {
	const { memory } = sessionBaseline(fixture());
	// "permision" misses "permission" exactly but is one letter away; "release notes" matches nothing.
	assert.deepEqual(memory, { memories: 2, prompts: 2, hit: 0, nearOnly: 1, none: 1 });
	assert.ok(trigramSimilarity("permision", "permission") > 0.8);
	assert.ok(trigramSimilarity("format", "information") < 0.5);
	assert.equal(nearScore({ title: "Unrelated", keywords: "" }, ["permision"]), 0);
});

test("renders every section and names what the database does not store", () => {
	const text = renderBaseline(sessionBaseline(fixture()), { githubTools: ["mcp__octocode__ghSearchCode"] });
	for (const heading of [
		"## Cache read share per day and role",
		"## Tool calls per tool per role",
		"| mcp__octocode__ghSearchCode | 0 | 1 | 0 |",
		"2 main sessions; 1 started none, 0 one, 1 two or more (50.0%)",
		"1 of 2 do not start with an outcome word",
		"## Not stored",
	])
		assert.ok(text.includes(heading), heading);
});

test("reads a database read-only through the database API and leaves the file unchanged", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-baseline-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "workspaces.db");
	const mirrorFile = join(dir, "transcripts.db");
	const agentDb = openDatabase({ file, mirrorFile, archiveDir: join(dir, "archive"), privateParent: false });
	const { sessions } = fixture();
	for (const id of ["main", "reviewer"]) {
		sessionRows.bind(agentDb.db, id, null);
		// `save` stores the header and each record as the line its file holds.
		transcripts.save(
			agentDb.mirror.db,
			id,
			join(dir, `${id}.jsonl`),
			JSON.stringify({ type: "session", id, ...sessions[id].header }),
			{ size: 1, mtime: "m", binding: "1:1" },
			sessions[id].entries.map((entry, index) => {
				const record = { ...entry, id: `${id}-${index}`, parentId: null };
				return { id: record.id, parentId: null, type: record.type, json: JSON.stringify(record) };
			}),
			0,
		);
	}
	agentDb.close();
	const digest = () => [file, mirrorFile].map((each) => createHash("sha256").update(readFileSync(each)).digest("hex"));
	const before = digest();
	const baseline = readBaseline(file);
	assert.deepEqual(digest(), before);
	assert.deepEqual(baseline.scope, { sessions: 2, measured: 2, excluded: 0, requests: 4 });
	// No run rows here: a session with a parent in its header is a child whose role is not stored.
	assert.deepEqual(
		baseline.tools.map((role) => role.role),
		["child (role not stored)", "main"],
	);
	assert.equal(baseline.children.twoOrMore, 1);
});

test("writes only under the checkout's temporary folder", () => {
	const tmp = join(tmpdir(), "repo", ".octocode", "tmp");
	assert.equal(outputPath(join(tmp, "a", "baseline.md"), tmp), join(tmp, "a", "baseline.md"));
	assert.throws(() => outputPath(join(tmp, "..", "baseline.md"), tmp), /must name a file under/);
	assert.throws(() => outputPath("/etc/baseline.md", tmp), /must name a file under/);
});
