import { describe, expect, it } from "vitest";
import type { Responder } from "../../src/gateway.ts";
import type { Step } from "../../src/script.ts";
import { type CapturedRequest, textOf } from "../../src/trace.ts";
import type { ToolDef } from "../../src/mcp.ts";
import { gateway, mcp } from "../helpers.ts";
import {
	addedMessages,
	afterCompaction,
	block,
	budgetViolations,
	bytes,
	byTurn,
	clearingViolations,
	mainRequests,
	namedPaths,
	noClearingViolations,
	restoreViolations,
	runFlow,
	toolResults,
	type FlowRun,
} from "./context-flows.ts";
import { requireBundle } from "./support.ts";

/** Replies to the main conversation in order; a request without tools (the summary request) gets `summary`. */
function sequence(steps: Step[], summary = "## Summary\nscripted summary"): Responder {
	let n = 0;
	return ({ request }) => {
		if (request.tools.length === 0) return { text: summary };
		return steps[n++] ?? { text: "done" };
	};
}

const bash = (command: string, extra: Record<string, unknown> = {}): Step => ({
	toolCalls: [{ name: "bash", args: { command, ...extra } }],
});

/**
 * Clearing: a writing command's big result (never clearable), three read-only results of 30,000 bytes (about 10k
 * estimated tokens each: one alone stays under the 20k-token floor, two reach it), then six results of `recentBytes`.
 * The two oldest read-only results leave the newest five once the fourth small one arrives; the third old one is left
 * alone afterwards, as it alone is under the floor.
 */
async function clearingRun(opts: { recentBytes: number; settings?: Record<string, unknown> }): Promise<FlowRun> {
	const big = (tag: string) => block(tag, 75);
	const files: Record<string, string> = { "w.txt": big("WRITE-OUT") };
	for (const i of [1, 2, 3]) files[`b${i}.txt`] = big(`OLD-${i}`);
	for (const i of [1, 2, 3, 4, 5, 6]) files[`s${i}.txt`] = block(`NEW-${i}`, Math.max(1, opts.recentBytes / 400));
	const steps = [
		bash("cat w.txt && touch w.done"),
		...[1, 2, 3].map((i) => bash(`cat b${i}.txt`)),
		...[1, 2, 3, 4, 5, 6].map((i) => bash(`cat s${i}.txt`)),
		{ text: "read them all" },
	];
	const gw = await gateway({ responder: sequence(steps) });
	try {
		return await runFlow(gw, {
			turns: ["read the files"],
			files,
			contextWindow: 200_000,
			settings: { bashOutputMaxBytes: 40_000, ...opts.settings },
			keep: (requests) =>
				toolResults(mainRequests(requests).at(-1) ?? requests[0]).flatMap((m) => namedPaths(textOf(m.content))),
		});
	} finally {
		await gw.close();
	}
}

const EDITED = `export const edited = "EDITED-BODY";\n${block("EDITED-LINE", 8, 80)}`;
const READ_ONLY = `export const read = "READ-BODY";\n${block("READ-LINE", 8, 80)}`;
const SCRATCH = `SCRATCH-BODY\n${block("SCRATCH-LINE", 8, 80)}`;

const fetchTool: ToolDef = {
	name: "fetch",
	description: "Read a workspace file",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/**
 * Compaction: T1 edits `src/edited.ts` and writes a scratch file under `.octocode/tmp` with `file`, and reads
 * `src/read.ts` whole through an MCP tool declared as a reader (or, with `editFile: false`, only reads both). T2 brings
 * about 25k estimated tokens and the agent calls `compact`: the recent-token tail keeps T2, so the compaction
 * summarizes exactly T1, and the 96k window leaves room for the turn to continue after it.
 */
async function compactionRun(opts: { summary: string; editFile?: boolean }) {
	const files = { "src/read.ts": READ_ONLY, "src/edited.ts": EDITED };
	if (opts.editFile !== false) files["src/edited.ts"] = "export const edited = 0;\n";
	const editStep: Step =
		opts.editFile === false
			? { toolCalls: [{ name: "mcp__src__fetch", args: { path: "src/edited.ts" } }] }
			: {
					toolCalls: [
						{
							name: "file",
							args: {
								reason: "edit",
								queries: [
									{
										type: "edit",
										path: "src/edited.ts",
										edits: [{ oldText: "export const edited = 0;\n", newText: EDITED }],
									},
									{ type: "write", path: ".octocode/tmp/scratch.txt", content: SCRATCH },
								],
							},
						},
					],
				};
	const script = byTurn(
		{
			T1: [editStep, { toolCalls: [{ name: "mcp__src__fetch", args: { path: "src/read.ts" } }] }, { text: "T1 done" }],
			T2: [{ toolCalls: [{ name: "compact", args: { reason: "boundary" } }] }],
		},
		opts.summary,
	);
	const gw = await gateway({ responder: script.responder });
	const src = mcp(gw, "src", [fetchTool]);
	src
		.tool("fetch")
		.mockImplementation((args) => ({ path: args.path, content: files[String(args.path) as keyof typeof files] }));
	try {
		const run = await runFlow(gw, {
			turns: ["T1 edit and read", `T2 ${block("FILL-T2", 250)}`],
			files: { ...files },
			contextWindow: 96_000,
			mcp: { src: { url: await src.listen(), roles: { reader: ["fetch"] } } },
		});
		return { run, summaryRequests: script.summaryRequests };
	} finally {
		await gw.close();
	}
}

const SUMMARY = "## Summary\nSUMMARY-MARK T1 edited src/edited.ts and read src/read.ts.";

/**
 * Measured on this scenario (bytes): what the summary request adds to the conversation it summarizes, and the
 * injected summary message. Each ceiling is the measured value +5%; never raise one to pass.
 */
// Measured 3,285 B (summary request) and 1,496 B (injected summary).
const SUMMARY_REQUEST_ADDED_MAX = 3_449;
const INJECTED_SUMMARY_MAX = 1_570;

function summaryBytes(run: FlowRun, summaryRequests: CapturedRequest[]) {
	const request = summaryRequests[0];
	const at = request ? run.requests.findIndex((r) => r.index === request.index) : -1;
	const before = at > 0 ? run.requests[at - 1] : undefined;
	const added = request ? bytes(JSON.stringify(addedMessages(request, request.tools.length ? before : undefined))) : 0;
	const after = request && afterCompaction(run, request);
	const injected = after?.messages.find((m) => textOf(m.content).includes("SUMMARY-MARK"));
	return { added, injected: injected ? bytes(textOf(injected.content)) : 0, after };
}

const BIG = block("BIG", 500, 200);
const BIG_MARKERS = { first: "BIG 0 ", last: "BIG 499 " };

/** Bash budget: three `cat` calls of a 100,000-byte file: plain, with a large `maxOutputTokens`, with a small one. */
async function budgetRun(settings: Record<string, unknown>): Promise<FlowRun> {
	const steps = [
		bash("cat big.txt"),
		bash("cat big.txt", { maxOutputTokens: 100_000 }),
		bash("cat big.txt", { maxOutputTokens: 500 }),
		{ text: "done" },
	];
	const gw = await gateway({ responder: sequence(steps) });
	try {
		return await runFlow(gw, {
			turns: ["show big.txt"],
			files: { "big.txt": BIG },
			contextWindow: 200_000,
			settings,
			keep: (requests) =>
				toolResults(mainRequests(requests).at(-1) ?? requests[0]).flatMap((m) => namedPaths(textOf(m.content))),
		});
	} finally {
		await gw.close();
	}
}

const budgetResults = (run: FlowRun): string[] =>
	toolResults(mainRequests(run.requests).at(-1) ?? run.requests[0]).map((m) => textOf(m.content));

const CLEARED = { cleared: [1, 2], markers: ["OLD-1 0 ", "OLD-2 0 "] };

describe("context flows (scripted gateway, real bundle)", () => {
	describe("post-compaction restore and summary", () => {
		it("brings back the edited file whole, the read-only file not whole, nothing from .octocode/tmp", async (ctx) => {
			requireBundle(ctx);
			const { run, summaryRequests } = await compactionRun({ summary: SUMMARY });
			expect(run.exitCode, run.stderr).toBe(0);
			expect(summaryRequests.length, "one compaction").toBe(1);
			const after = afterCompaction(run, summaryRequests[0]);
			const expectation = {
				whole: { "src/edited.ts": EDITED },
				notWhole: { "src/read.ts": READ_ONLY },
				absent: { scratch: "SCRATCH-BODY" },
			};
			expect(restoreViolations(after, expectation)).toEqual([]);
			// The finder reports each broken case on this same wire: a read-only file expected whole, a restored file expected absent.
			expect(
				restoreViolations(after, {
					whole: { read: READ_ONLY },
					notWhole: { edited: EDITED },
					absent: { e: "EDITED-BODY" },
				}),
			).toEqual(["read not whole", "edited came back whole", "e came back"]);
			const measured = summaryBytes(run, summaryRequests);
			console.log(`context-flows: summary request adds ${measured.added} B, injected summary ${measured.injected} B`);
			expect(measured.injected).toBeGreaterThan(0);
			expect(measured.added).toBeLessThanOrEqual(SUMMARY_REQUEST_ADDED_MAX);
			expect(measured.injected).toBeLessThanOrEqual(INJECTED_SUMMARY_MAX);
		}, 180_000);

		it("negative: a file only read, never edited, does not come back whole", async (ctx) => {
			requireBundle(ctx);
			const { run, summaryRequests } = await compactionRun({ summary: SUMMARY, editFile: false });
			expect(run.exitCode, run.stderr).toBe(0);
			const after = summaryRequests[0] && afterCompaction(run, summaryRequests[0]);
			expect(restoreViolations(after, { whole: { "src/edited.ts": EDITED }, notWhole: {}, absent: {} })).toEqual([
				"src/edited.ts not whole",
			]);
		}, 180_000);

		it("negative: a longer summary breaks the injected-summary ceiling", async (ctx) => {
			requireBundle(ctx);
			const long = `${SUMMARY}\n${block("LONG-SUMMARY", 20, 200)}`;
			const { run, summaryRequests } = await compactionRun({ summary: long });
			expect(run.exitCode, run.stderr).toBe(0);
			expect(summaryBytes(run, summaryRequests).injected).toBeGreaterThan(INJECTED_SUMMARY_MAX);
		}, 180_000);
	});

	describe("bash output budget", () => {
		it("cuts a huge output to the configured budget with the saved log; maxOutputTokens only lowers it", async (ctx) => {
			requireBundle(ctx);
			const run = await budgetRun({ bashOutputMaxBytes: 8_000 });
			expect(run.exitCode, run.stderr).toBe(0);
			const [plain, raised, lowered] = budgetResults(run);
			expect(budgetViolations(plain, run.saved, 8_000, BIG_MARKERS)).toEqual([]);
			expect(budgetViolations(raised, run.saved, 8_000, BIG_MARKERS)).toEqual([]);
			expect(budgetViolations(lowered, run.saved, 2_000, BIG_MARKERS)).toEqual([]);
			console.log(`context-flows: bash results ${[plain, raised, lowered].map((r) => bytes(r ?? "")).join(", ")} B`);
		}, 180_000);

		it("negative: without the setting the default budget is larger, and the 8,000-byte check reports it", async (ctx) => {
			requireBundle(ctx);
			const run = await budgetRun({});
			expect(run.exitCode, run.stderr).toBe(0);
			const found = budgetViolations(budgetResults(run)[0], run.saved, 8_000, BIG_MARKERS);
			expect(found.some((f) => f.startsWith("result is "))).toBe(true);
		}, 180_000);
	});

	describe("stale-result clearing", () => {
		it("clears the old read-only results once, keeps the newest five and the writing command, then appends", async (ctx) => {
			requireBundle(ctx);
			const run = await clearingRun({ recentBytes: 400 });
			expect(run.exitCode, run.stderr).toBe(0);
			const kept: Array<[number, string]> = [
				[0, "WRITE-OUT 0 "],
				[3, "OLD-3 0 "],
				...[1, 2, 3, 4, 5, 6].map((i): [number, string] => [3 + i, `NEW-${i} 0 `]),
			];
			expect(clearingViolations(run, { ...CLEARED, kept }, 30_000)).toEqual([]);
		}, 180_000);

		it("does not clear when the newest results are large: rewriting them costs more than the reads saved", async (ctx) => {
			requireBundle(ctx);
			const run = await clearingRun({ recentBytes: 30_000 });
			expect(run.exitCode, run.stderr).toBe(0);
			expect(noClearingViolations(run, ["OLD-1 0 ", "OLD-2 0 ", "OLD-3 0 ", "WRITE-OUT 0 "])).toEqual([]);
		}, 180_000);

		it("negative: with prompt caching off nothing is cleared, and the clearing finder reports it", async (ctx) => {
			requireBundle(ctx);
			const run = await clearingRun({ recentBytes: 400, settings: { cacheRetention: "none" } });
			expect(run.exitCode, run.stderr).toBe(0);
			const found = clearingViolations(run, { ...CLEARED, kept: [] }, 30_000);
			expect(found).toContain("result 1 still carries its text");
			expect(found).toContain("expected one edit wave, saw 0 ()");
		}, 180_000);
	});
});
