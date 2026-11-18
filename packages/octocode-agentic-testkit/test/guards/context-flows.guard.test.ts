import { describe, expect, it } from "vitest";
import type { Responder } from "../../src/gateway.ts";
import type { Step } from "../../src/script.ts";
import { textOf } from "../../src/trace.ts";
import type { ToolDef } from "../../src/mcp.ts";
import { gateway, mcp } from "../helpers.ts";
import {
	block,
	byTurn,
	clearingViolations,
	mainRequests,
	namedPaths,
	noClearingViolations,
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
 * Compaction: T1 writes `src/edited.ts` and a scratch file under `.octocode/tmp` with `file`, and reads `src/read.ts`
 * whole through an MCP tool declared as a reader; T2 and T3 each bring about 27k estimated tokens, so T3 overflows the
 * 96k window and the session compacts with T1 summarized.
 */
async function compactionRun(summary: string): Promise<FlowRun> {
	const files = { "src/read.ts": READ_ONLY, "src/edited.ts": "export const edited = 0;\n" };
	const gw = await gateway({
		responder: byTurn(
			{
				T1: [
					{
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
					},
					{ toolCalls: [{ name: "mcp__src__fetch", args: { path: "src/read.ts" } }] },
					{ text: "T1 done" },
				],
			},
			summary,
		),
	});
	const src = mcp(gw, "src", [fetchTool]);
	src.tool("fetch").mockImplementation((args) => ({ path: args.path, content: READ_ONLY }));
	try {
		return await runFlow(gw, {
			turns: ["T1 edit and read", `T2 ${block("FILL-T2", 200)}`, `T3 ${block("FILL-T3", 200)}`],
			files,
			contextWindow: 64_000,
			mcp: { src: { url: await src.listen(), roles: { reader: ["fetch"] } } },
		});
	} finally {
		await gw.close();
	}
}

const CLEARED = { cleared: [1, 2], markers: ["OLD-1 0 ", "OLD-2 0 "] };

describe("context flows (scripted gateway, real bundle)", () => {
	describe("compaction", () => {
		it("measure", async (ctx) => {
			requireBundle(ctx);
			const run = await compactionRun("## Summary\nT1 edited src/edited.ts and read src/read.ts.");
			expect(run.exitCode, run.stderr).toBe(0);
			const { writeFileSync } = await import("node:fs");
			writeFileSync(
				"/Users/bgaryy/code/octocodecode/.octocode/code/temp/agents/inky-starfish-2/compaction.json",
				JSON.stringify(run.requests.map((r) => ({ tools: r.tools.length, messages: r.messages }))),
			);
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
