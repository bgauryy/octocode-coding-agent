import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_DIR } from "./agent-context/capture.ts";
import { replayLine } from "./replay/report.ts";
import { replay, type ReplayResult } from "./replay/run.ts";

/**
 * A real recorded session (`large-session.jsonl`: 88 prompts, about 430 replies, 370 tool calls, 1 MB) replayed through a
 * real main session at full size, offline: each request gets the recorded reply, each tool call the recorded result
 * (`replay/`). The window is small enough that the recording compacts several times. The run happens once; each `it`
 * judges one property. Model behavior is fixed by the recording, so this tests the session around the model: requests,
 * compaction, persistence, the database mirror and the profiler, not the quality of the replies.
 */

const FIXTURE = path.join(PACKAGE_DIR, "test", "fixtures", "large-session.jsonl");
/** 80k tokens: the fixture compacts three times, with room above the two it must reach. */
const WINDOW = 80_000;
/** Far above the 200 ms a stall entry records and the ~100 ms measured: only a real block of the loop reaches it. */
const LOOP_BLOCK_MS = 1_000;

describe("a recorded session replayed through a real session (scripted from the recording)", () => {
	let result: ReplayResult;

	beforeAll(async () => {
		result = await replay({ source: FIXTURE, contextWindow: WINDOW, name: "large-session" });
		// The record of this run, so runs can be compared: sizes, counts and time.
		process.stderr.write(`${replayLine(result)}\n`);
	}, 300_000);

	it("replays every recorded turn, each request answered by the recording", () => {
		expect(result.recording.turns).toBe(88);
		expect(result.turnsDone).toBe(result.recording.turns);
		expect(result.promptErrors).toEqual([]);
		expect(result.failedRuns).toEqual([]);
		expect(result.finalIdle).toBe(true);
		expect(result.model.unscripted).toEqual([]);
		expect(result.model.diverged).toEqual([]);
		expect(result.leftovers).toEqual([]);
		expect(result.tools.notRecorded).toEqual([]);
		// Every call the session ran was answered by a stand-in: no call was refused or ran a real tool.
		expect(result.tools.refused).toEqual([]);
		expect(result.tools.replayed).toBe(result.tools.ended);
		// Not vacuous: the recording's replies all went through the model.
		expect(result.recording.replies).toBeGreaterThan(400);
		expect(result.model.requests - result.model.summaryRequests).toBeGreaterThanOrEqual(result.recording.replies);
	});

	it("keeps the system prompt and tool array byte-identical between compactions", () => {
		expect(result.model.systemChanges).toEqual([]);
		expect(result.model.systemsPerSegment).toHaveLength(result.compactions.count + 1);
		expect(result.model.systemsPerSegment.every((count) => count === 1)).toBe(true);
		expect(result.model.toolArraysPerSegment.every((count) => count === 1)).toBe(true);
	});

	it("extends the previous request, except right after a compaction or a clearing of old results", () => {
		expect(result.model.prefixBreaks).toEqual([]);
		expect(result.model.changedInPlace).toEqual([]);
		expect(result.model.contextAfterCompaction).toHaveLength(result.compactions.count);
	});

	it("compacts more than once and keeps every request under the window", () => {
		expect(result.compactions.count).toBeGreaterThanOrEqual(2);
		expect(result.compactions.count).toBe(result.model.compactionsSeen);
		expect(result.profiler.peakPromptTokens).toBeLessThan(WINDOW);
		// Not vacuous: the session did fill most of the window before compacting.
		expect(result.profiler.peakPromptTokens).toBeGreaterThan(WINDOW / 2);
		// A compaction gives most of the window back.
		expect(Math.max(...result.model.contextAfterCompaction)).toBeLessThan(result.model.peakContextChars * 0.8);
	});

	it("keeps every user message recoverable after every compaction", () => {
		expect(result.recovery).toHaveLength(result.compactions.count);
		for (const row of result.recovery) {
			expect(row.before).toBeGreaterThan(0);
			expect({ compaction: row.compaction, lost: row.lost }).toEqual({ compaction: row.compaction, lost: [] });
			expect(row.inline + row.referenced + row.transcript).toBe(row.before);
		}
	});

	it("reopens to the same projection, with the database mirror level with the file", () => {
		expect(result.projectionStable).toBe(true);
		expect(result.mirror.byteSize).toBe(result.file.bytes);
		expect(result.mirror.records).toBe(result.file.lines);
		expect(result.persistenceFailures).toEqual([]);
	});

	it("profiles every tool call and reply, without blocking the event loop", () => {
		expect(result.profiler.toolResults).toBeGreaterThan(300);
		expect(result.profiler.withPhases).toBe(result.profiler.toolResults);
		expect(result.profiler.withFirstToken).toBe(result.profiler.replies);
		// Measured 0 stall entries and a loop delay under ~130 ms on an idle machine; the bound leaves room for a loaded CI.
		expect(result.profiler.maxStallMs).toBeLessThan(LOOP_BLOCK_MS);
		expect(result.timing.loop.maxMs).toBeLessThan(LOOP_BLOCK_MS);
	});
});
