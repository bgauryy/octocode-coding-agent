import "../bundle.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runOctocodecode } from "../../src/adapters/octocodecode/index.ts";
import type { Responder } from "../../src/gateway.ts";
import { textOf, Trace, type CapturedRequest } from "../../src/trace.ts";
import { gateway, mcp, searchTool } from "../helpers.ts";
import { anthropicHome, gatedProxy, traceRows, writeTrace, type TraceRow } from "./cache-trace.ts";
import { requireBundle } from "./support.ts";

/**
 * Measured on the bundled agent over the Anthropic wire (scripted model, no network), plus ~5%. Raise only with a
 * reviewed reason; the trace JSON in `.octocode/tmp/cache-trace/` shows the measured values.
 */
const CEILING = {
	/** Every tool declared at the top level; the MCP connect appends to that list. */
	none: {
		/** Request 1: tool definitions, system prompt. */
		toolsBytes: 42_200,
		systemBytes: 31_600,
		/** The mid-session MCP connect: the added tool definition and the message-borne `mcps` delta. */
		mcpToolDeltaBytes: 250,
		mcpMessageDeltaBytes: 5_300,
		/** The date rollover: one `environment` section update, no head edit. */
		dateDeltaBytes: 580,
	},
	/** Fewer top-level tools (MCP tools listed in `mcps`); the connect adds an in-place tool block. */
	changes: {
		toolsBytes: 31_600,
		systemBytes: 33_000,
		mcpToolDeltaBytes: 320,
		mcpMessageDeltaBytes: 6_600,
		dateDeltaBytes: 399,
	},
};
type Transport = keyof typeof CEILING;
type Measured = Record<keyof (typeof CEILING)["none"], number>;
/** Anthropic accepts at most four explicit cache breakpoints per request. */
const MAX_MARKERS = 4;

const FLAGS = ["--mode", "json", "--no-session", "--offline", "--trust", "--model", "testkit/scripted"];
/** About 28k estimated tokens: two of these overflow the 96k window, so the agent compacts on its own. */
const FILLER = Array.from({ length: 2000 }, (_, i) => `note ${i}: the quick brown fox jumps over the lazy dog`).join(
	"\n",
);
const TURNS = [
	`T1 read a.txt\n${FILLER}`,
	"T2 connect docs and search it",
	`T3 keep these notes\n${FILLER}`,
	"T4 finish",
];

/** The turn marker of the newest scripted user message (`T1`…`T4`) and the assistant replies since it. */
function position(request: CapturedRequest): { turn: string; replies: number } {
	const at = request.messages.findLastIndex((m) => m.role === "user" && /^T\d /.test(textOf(m.content)));
	const turn = at < 0 ? "" : textOf(request.messages[at].content).slice(0, 2);
	return { turn, replies: request.messages.slice(at + 1).filter((m) => m.role === "assistant").length };
}

const view = (requests: CapturedRequest[]): Trace => {
	const t = new Trace();
	t.requests.push(...requests);
	return t;
};

describe("cache trace (scripted gateway, real bundle, Anthropic wire)", () => {
	it("the change classifier tells an appended delta from an edit of earlier bytes", () => {
		const req = (system: unknown, tools: unknown[], messages: unknown[]): CapturedRequest =>
			({ index: 0, messages: [], raw: { system, tools, messages } }) as unknown as CapturedRequest;
		const marked = { type: "ephemeral" };
		const t1 = { name: "a", input_schema: { cache_control: "not a marker" } };
		const t2 = { name: "b", cache_control: marked };
		const sys = "<tools>\nx\n</tools>\n<env>\nday 1\n</env>";
		const u1 = { role: "user", content: [{ type: "text", text: "hi", cache_control: marked }] };
		const u2 = { role: "user", content: [{ type: "text", text: "next" }] };
		const rows = traceRows([
			req(sys, [t1], [u1]),
			req(sys, [t1, t2], [u1, u2]),
			req(sys.replace("day 1", "day 2"), [t2, t1], [u2]),
		]);
		expect(rows.map((r) => r.markers)).toEqual([1, 2, 1]);
		// A moved marker is not a change; an appended tool or message is an append.
		expect(rows[1].change).toMatchObject({ tools: { kind: "append", at: "b" }, messages: { kind: "append" } });
		expect(rows[1].firstChanged).toBe("tools:append@b");
		// Reordered tools, an edited section and a rewritten history are edits, located at their first difference.
		expect(rows[2].change).toMatchObject({
			tools: { kind: "edit", at: "b" },
			system: { kind: "edit", at: "env" },
			messages: { kind: "edit", at: "messages[0]" },
		});
	});

	it(
		"transport none: tool round, mid-session MCP connect and compaction keep the prefix and append every change",
		{ timeout: 150_000 },
		async (ctx) => {
			requireBundle(ctx);
			const s = await scenario("none");
			const { main, rows, connect, compacted, rollover } = s;
			const segments = [main.slice(0, connect), main.slice(connect, compacted), main.slice(compacted)];
			for (const seg of segments) {
				expect(seg.length, "each segment has a warm request").toBeGreaterThanOrEqual(2);
				expect(view(seg)).toKeepStablePrefix({ raw: true });
			}
			const [cold] = rows;
			for (const [i, r] of rows.entries()) {
				expect(r.markers, `request ${r.index}: cache markers`).toBeLessThanOrEqual(MAX_MARKERS);
				// The system prompt never changes within the session: section updates travel in messages.
				expect(r.hash.system, `request ${r.index}: system hash`).toBe(cold.hash.system);
				if (i === 0) continue;
				if (i < connect) expect(r.hash.tools, `request ${r.index}: tools hash`).toBe(cold.hash.tools);
				else if (i > connect) expect(r.hash.tools, `request ${r.index}: tools hash`).toBe(rows[connect].hash.tools);
				// Every change other than the compaction is an append: no earlier message is rewritten.
				if (i !== compacted) expect(r.change.messages.kind, `request ${r.index}: messages`).toBe("append");
			}
			// Transport none: the MCP connect appends the server's tools to the top-level list (a full cache miss).
			const at = rows[connect];
			const before = rows[connect - 1];
			expect(at.change.tools).toMatchObject({ kind: "append", at: "mcp__docs__search" });
			expect(at.change.system.kind).toBe("same");
			expect(at.inlineTools.added).toEqual([]);
			expect(at.cachedTokens).toBe(0);
			expectRollover(rows, rollover);
			expectCompaction(rows[compacted]);
			expectCeilings("none", {
				toolsBytes: cold.bytes.tools,
				systemBytes: cold.bytes.system,
				mcpToolDeltaBytes: at.bytes.tools - before.bytes.tools,
				mcpMessageDeltaBytes: at.bytes.messages - before.bytes.messages,
				dateDeltaBytes: dateDelta(rows, rollover),
			});
		},
	);

	it(
		"transport changes: the MCP connect arrives as an in-place tool block and keeps the cached prefix",
		{ timeout: 150_000 },
		async (ctx) => {
			requireBundle(ctx);
			const s = await scenario("changes", { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true });
			const { main, rows, connect, compacted, rollover } = s;
			const segments = [main.slice(0, compacted), main.slice(compacted)];
			for (const seg of segments) {
				expect(seg.length, "each segment has a warm request").toBeGreaterThanOrEqual(2);
				expect(view(seg)).toKeepStablePrefix({ raw: true });
			}
			const [cold] = rows;
			for (const [i, r] of rows.entries()) {
				expect(r.markers, `request ${r.index}: cache markers`).toBeLessThanOrEqual(MAX_MARKERS);
				expect(r.hash.system, `request ${r.index}: system hash`).toBe(cold.hash.system);
				// The top-level tool list never changes: tool changes travel in messages.
				expect(r.hash.tools, `request ${r.index}: tools hash`).toBe(cold.hash.tools);
				if (i > 0 && i !== compacted) expect(r.change.messages.kind, `request ${r.index}: messages`).toBe("append");
			}
			const at = rows[connect];
			const before = rows[connect - 1];
			expect(at.change.tools.kind).toBe("same");
			expect(at.change.system.kind).toBe("same");
			expect(at.change.messages.kind).toBe("append");
			expect(before.inlineTools.added).not.toContain("mcp__docs__search");
			expect(at.inlineTools.added).toContain("mcp__docs__search");
			// The connect request reads the whole previous prompt from cache (gateway estimate: chars / 4, rounded up).
			expect(at.cachedTokens ?? 0).toBeGreaterThan(0);
			expect(at.cachedTokens ?? 0).toBeGreaterThanOrEqual((before.promptTokens ?? 0) - 1);
			expectRollover(rows, rollover);
			expectCompaction(rows[compacted]);
			expectCeilings("changes", {
				toolsBytes: cold.bytes.tools,
				systemBytes: cold.bytes.system,
				mcpToolDeltaBytes: at.inlineTools.bytes - before.inlineTools.bytes,
				mcpMessageDeltaBytes: at.bytes.messages - before.bytes.messages,
				dateDeltaBytes: dateDelta(rows, rollover),
			});
		},
	);
});

const dateDelta = (rows: TraceRow[], i: number): number => rows[i].bytes.messages - rows[i - 1].bytes.messages;

/** A new day appends one message: tools and the head stay byte-identical, so the cached prefix is untouched. */
function expectRollover(rows: TraceRow[], i: number): void {
	const r = rows[i];
	expect(r.hash.tools, "rollover: tools hash").toBe(rows[0].hash.tools);
	expect(r.hash.system, "rollover: system hash").toBe(rows[0].hash.system);
	expect(r.change.tools.kind).toBe("same");
	expect(r.change.system.kind).toBe("same");
	expect(r.change.messages.kind).toBe("append");
}

/** Compaction replaces history but keeps tools and system bytes. */
function expectCompaction(post: TraceRow): void {
	expect(post.change.tools.kind).toBe("same");
	expect(post.change.system.kind).toBe("same");
	expect(post.change.messages.kind).toBe("edit");
}

function expectCeilings(transport: Transport, measured: Measured): void {
	const ceiling = CEILING[transport];
	console.info(`[guard:cache-trace] ${JSON.stringify({ transport, measured, ceiling })}`);
	for (const k of Object.keys(ceiling) as (keyof Measured)[])
		expect(measured[k], `${transport} ${k}: measured ${measured[k]} vs ceiling ${ceiling[k]}`).toBeLessThanOrEqual(
			ceiling[k],
		);
}

interface Scenario {
	main: CapturedRequest[];
	rows: TraceRow[];
	/** Row of the first request after the MCP restart, and of the first request after the compaction. */
	connect: number;
	compacted: number;
	/** Row of the request that carries the date rollover. */
	rollover: number;
}

/**
 * T1 a large message and a bash round; T2 the model restarts the `docs` MCP server (down at startup) and searches it;
 * T3 a large message that overflows the window, so the agent compacts first; T4 a plain answer. One process, one
 * session; the trace lands in `scripted-<transport>.json`.
 */
async function scenario(transport: Transport, compat?: Record<string, unknown>): Promise<Scenario> {
	const proxy = await gatedProxy();
	let docsUrl = "";
	let compactorRequests = 0;
	// The agent's clock jumps one day when T1 ends (see clock.mjs), so T2's prompt carries a new `Date:`.
	const flag = join(mkdtempSync(join(tmpdir(), "testkit-clock-")), "rollover");
	const rollOver = (): { text: string } => {
		writeFileSync(flag, "");
		return { text: "T1 done" };
	};
	const responder: Responder = ({ request, trace }) => {
		// The summary request carries no tools; every other request is the main conversation.
		if (request.tools.length === 0) {
			compactorRequests++;
			trace.record({ kind: "compaction", agent: request.agent, span: request.span });
			return { text: "## Summary\nT1 read a.txt; T2 connected docs and searched it." };
		}
		const { turn, replies } = position(request);
		if (turn === "T1")
			return replies === 0
				? { toolCalls: [{ name: "bash", args: { command: "cat a.txt", reason: "read" } }] }
				: rollOver();
		if (turn === "T2") {
			if (replies === 0) {
				// The server comes up now: the startup connect failed, the restart reaches it.
				proxy.open(docsUrl);
				return { toolCalls: [{ name: "mcp", args: { intent: "restart", server: "docs", reason: "connect" } }] };
			}
			if (replies === 1) return { toolCalls: [{ name: "mcp__docs__search", args: { query: "cache" } }] };
			return { text: "T2 done" };
		}
		return { text: `${turn} done` };
	};
	const gw = await gateway({ responder });
	const docs = mcp(gw, "docs", [searchTool]);
	docs.tool("search").returns("DOCS-HIT-9");
	docsUrl = await docs.listen();
	const home = anthropicHome({ gatewayUrl: gw.url, contextWindow: 96_000, mcp: { docs: proxy.url }, compat });
	let run: Awaited<ReturnType<typeof runOctocodecode>>;
	try {
		// One process, four user turns in one session: earlier messages go before the adapter's final prompt.
		run = await runOctocodecode({
			gatewayUrl: gw.url,
			args: [...FLAGS, ...TURNS.slice(0, -1)],
			prompt: TURNS.at(-1)!,
			files: { "a.txt": "AAA\n" },
			env: {
				OCTOCODE_HOME: home.home,
				TESTKIT_ROLLOVER_FLAG: flag,
				NODE_OPTIONS: `--import=${fileURLToPath(new URL("./clock.mjs", import.meta.url))}`,
			},
			timeoutMs: 120_000,
		});
	} finally {
		home.close();
		await proxy.close();
	}
	expect(run.exitCode, run.stderr.slice(-2000)).toBe(0);
	expect(gw.errors).toEqual([]);

	const all = gw.trace.requests;
	const main = all.filter((r) => r.tools.length > 0);
	const compactor = all.filter((r) => r.tools.length === 0);
	const rows = traceRows(main);
	const file = writeTrace(process.env.TESTKIT_REPORT_DIR ?? ".octocode/tmp", transport, {
		transport,
		compat: compat ?? null,
		scenario: [
			"T1: large user message, one bash tool round",
			"T2: MCP server docs (down at startup) restarted by the model mid-session, then one docs search",
			"T3: large user message that overflows the window: automatic compaction before it",
			"T4: plain answer",
		],
		wire: "anthropic-messages (scripted gateway; markers are the agent's own)",
		contextWindow: 96_000,
		ceilings: CEILING[transport],
		main: rows,
		compactor: traceRows(compactor),
	});
	console.info(`[guard:cache-trace] ${file}`);

	// The scenario ran as scripted.
	expect(gw.trace).toHaveCalledTool("bash", { before: "answer" });
	expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" } });
	expect(gw.trace).toHaveCompacted();
	expect(compactorRequests).toBe(1);
	const connect = main.findIndex((r) => {
		const p = position(r);
		return p.turn === "T2" && p.replies === 1;
	});
	const compacted = main.findIndex((r) => r.index > compactor[0].index);
	expect(connect, "a request follows the MCP restart").toBeGreaterThan(0);
	expect(compacted).toBeGreaterThan(connect);
	const rollover = main.findIndex((r) => {
		const p = position(r);
		return p.turn === "T2" && p.replies === 0;
	});
	expect(rollover, "a request follows the date rollover").toBeGreaterThan(0);
	// The clock moved one day: T2's prompt carries only the environment section, as a message after the history.
	const tomorrow = new Date(Date.now() + 86_400_000);
	const day = [tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate()]
		.map((n, i) => String(n).padStart(i ? 2 : 4, "0"))
		.join("-");
	// Models with mid-conversation system messages get it as a `system` turn, the others as a marked user turn.
	const sent = main[rollover].messages
		.slice(main[rollover - 1].messages.length)
		.map((m) => textOf(m.content))
		.filter((t) => /Updated system prompt section|System update from the harness/.test(t));
	expect(sent).toEqual([expect.stringContaining(`Date: ${day}`)]);
	expect(sent[0]).toMatch(/section "environment(:date)?"/);
	expect(sent[0]).not.toMatch(/<(tools|rules|mcps)>/);
	// The connect sends the `mcps` update as a message either way.
	const added = main[connect].messages.slice(main[connect - 1].messages.length).map((m) => textOf(m.content));
	expect(added.some((t) => t.includes("<mcps>") && t.includes("docs"))).toBe(true);
	return { main, rows, connect, compacted, rollover };
}

describe("cache trace: steps that wait on other work", () => {
	it.skip("B601: a foreign backlog write by a second session arrives as one event line at the next user turn", () => {
		// Needs RFC T5 (B601): the follower that appends foreign-change events. Then: a second process writes the backlog
		// between T2 and T3; assert the event is one appended message, tools and head hashes unchanged.
	});

	it.skip("idle gap: warm requests bridge a tool that outlasts the cache lifetime and change no layer", () => {
		// Probe 2026-11-17: with a declared 20 s lifetime, prices and cacheWarming "streaming", a 14 s bash call sent no
		// one-token warm request through the scripted wire (2 requests in total). Find what gates the warmer in a
		// --mode json run before turning this on; then count requests with max_tokens 1 and assert their layers are equal.
	});
});
