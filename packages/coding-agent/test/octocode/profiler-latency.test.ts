import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { timelineTable } from "../../src/octocode/profiler/format.ts";
import { createProfiler } from "../../src/octocode/profiler/index.ts";
import { STALL_ENTRY } from "../../src/octocode/profiler/stalls.ts";
import { toChromeTrace } from "../../src/octocode/profiler/trace.ts";

const T = Date.UTC(2026, 10, 13, 10, 0, 0);
const iso = (ms: number) => new Date(T + ms).toISOString();
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const usage = (input: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10 });
const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/**
 * A prompt at T; a failed attempt ending at +12s; its retry starting at +35s (35s to first token); a bash call held 6s
 * behind a slower sibling, whose 9s preparation was mostly an 8s permission wait; a grep call with a 7s preparation;
 * and a 1.5s event-loop stall during the request.
 */
function profiler() {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-latency-"));
	folders.push(folder);
	const file = path.join(folder, "main.jsonl");
	const entries = [
		{ type: "session", id: "s" },
		{ type: "message", id: "u", timestamp: iso(0), message: { role: "user", content: "go", timestamp: T } },
		{
			type: "message",
			id: "failed",
			timestamp: iso(12_000),
			message: { role: "assistant", content: [], stopReason: "error", durationMs: 2000, usage: usage(0) },
		},
		{
			type: "message",
			id: "a",
			timestamp: iso(80_000),
			message: {
				role: "assistant",
				model: "m",
				content: [],
				stopReason: "toolUse",
				durationMs: 45_000,
				firstTokenMs: 35_000,
				usage: usage(1000),
			},
		},
		{
			type: "custom",
			id: "perm",
			timestamp: iso(92_500),
			customType: "octocode-permission",
			data: { askedAt: T + 84_500, at: T + 92_500, action: "shell.run" },
		},
		{
			type: "message",
			id: "bash",
			timestamp: iso(100_000),
			message: {
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				durationMs: 1000,
				phases: { prepareMs: 9000, heldMs: 6000 },
			},
		},
		{
			type: "message",
			id: "grep",
			timestamp: iso(110_000),
			message: {
				role: "toolResult",
				toolName: "grep",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				durationMs: 100,
				phases: { prepareMs: 7000 },
			},
		},
		{
			type: "custom",
			id: "stall",
			timestamp: iso(110_500),
			customType: STALL_ENTRY,
			data: { version: 1, from: T + 40_000, at: T + 80_000, maxMs: 1500, p99Ms: 900, during: "request" },
		},
	];
	fs.writeFileSync(file, entries.map(line).join(""));
	return createProfiler({
		sessionId: "s1",
		self: () => ({ id: "main", role: "main", status: "working" }),
		coordinatorFile: () => file,
		members: () => [],
		traffic: () => [],
		transcript: () => undefined,
	});
}

describe("profiler latency phases", () => {
	it("places tool executions by their phases and shows request, retry, turn-start and stall spans", () => {
		const events = profiler().timeline().events;
		expect(events.filter((event) => event.kind === "wait" && event.label !== "permission")).toMatchObject([
			{ label: "turn start", at: T, durationMs: 10_000 },
			{ label: "retry", at: T + 12_000, durationMs: 23_000 },
		]);
		expect(events.find((event) => event.kind === "request")).toMatchObject({
			at: T + 35_000,
			phases: { firstToken: 35_000, stream: 10_000 },
		});
		expect(events.find((event) => event.label === "bash")).toMatchObject({
			at: T + 93_000,
			durationMs: 1000,
			phases: { prepare: 9000, execute: 1000, held: 6000 },
		});
		expect(events.find((event) => event.kind === "stall")).toMatchObject({
			at: T + 40_000,
			durationMs: 40_000,
			label: "event loop blocked 1500ms during request",
		});
	});

	it("names the bottleneck phase of each slow interaction", () => {
		const findings = profiler().insights().findings;
		const byKind = (kind: string) => findings.filter((finding) => finding.kind === kind);
		// bash: 9s preparation minus the 8s permission wait leaves 1s, so its held result is the bottleneck.
		// Most costly first: grep's 7s preparation, then bash's 6s.
		expect(byKind("slow-phase").map((finding) => finding.title)).toEqual([
			"grep waited before it ran (argument checks, hooks, permission check): 7.0s",
			"bash had its result held for slower calls of the same message: 6.0s",
		]);
		expect(byKind("slow-first-token")).toMatchObject([{ agentId: "main", waitedMs: 35_000 }]);
		expect(byKind("slow-turn-start")).toMatchObject([{ agentId: "main", waitedMs: 10_000 }]);
		expect(byKind("retry-wait")).toMatchObject([{ agentId: "main", waitedMs: 23_000 }]);
		expect(byKind("main-thread-stall")).toMatchObject([
			{ severity: "medium", waitedMs: 1500, title: "main's event loop was blocked up to 1500ms during request" },
		]);
	});

	it("exports phases as spans on a phases thread and lists them in the terminal timeline", () => {
		const timeline = profiler().timeline();
		const trace = toChromeTrace(["main"], timeline.events, []);
		const spans = trace.traceEvents.filter((event) => event.tid === 2 && event.ph === "X");
		expect(spans.map((event) => event.name)).toEqual(
			expect.arrayContaining(["m: firstToken", "m: stream", "bash: prepare", "bash: held", "grep: prepare"]),
		);
		const held = spans.find((event) => event.name === "bash: held")!;
		expect(held).toMatchObject({ ts: (T + 94_000) * 1000, dur: 6000 * 1000 });
		const text = timelineTable(timeline);
		expect(text).toContain("bash  [prepare 9.0s, held 6.0s]");
		expect(text).toContain("[first token 35.0s, stream 10.0s]");
	});

	it("leaves results without phases where they were", () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-latency-legacy-"));
		folders.push(folder);
		const file = path.join(folder, "main.jsonl");
		fs.writeFileSync(
			file,
			line({ type: "session", id: "s" }) +
				line({
					type: "message",
					id: "r",
					timestamp: iso(5000),
					message: { role: "toolResult", toolName: "read", content: [], isError: false, durationMs: 2000 },
				}),
		);
		const legacy = createProfiler({
			sessionId: "s1",
			self: () => ({ id: "main", role: "main", status: "working" }),
			coordinatorFile: () => file,
			members: () => [],
			traffic: () => [],
			transcript: () => undefined,
		});
		const tool = legacy.timeline().events.find((event) => event.kind === "tool");
		expect(tool).toMatchObject({ at: T + 3000, durationMs: 2000 });
		expect(tool).not.toHaveProperty("phases");
		expect(legacy.insights().findings.map((finding) => finding.kind)).not.toContain("slow-phase");
	});
	it("shows a compaction as the span its summary held the turn, with how it was written", () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-latency-compaction-"));
		folders.push(folder);
		const file = path.join(folder, "main.jsonl");
		const compaction = (id: string, at: number, details: unknown) =>
			line({ type: "compaction", id, timestamp: iso(at), summary: "## Goal\nx", firstKeptEntryId: "s", details });
		fs.writeFileSync(
			file,
			line({ type: "session", id: "s" }) +
				compaction("c1", 20_000, { summaryMethod: { method: "cache-shared", ms: 12_000 } }) +
				compaction("c2", 60_000, {
					summaryMethod: { method: "cache-shared", early: { requestedAt: iso(30_000), waitedMs: 0 }, ms: 40 },
				}) +
				// A compaction from before the duration was recorded stays a point in time.
				compaction("c3", 90_000, { summaryMethod: { method: "standalone", reason: "overflow" } }),
		);
		const events = createProfiler({
			sessionId: "s1",
			self: () => ({ id: "main", role: "main", status: "working" }),
			coordinatorFile: () => file,
			members: () => [],
			traffic: () => [],
			transcript: () => undefined,
		})
			.timeline()
			.events.filter((event) => event.kind === "compaction");
		expect(events).toMatchObject([
			{ at: T + 8000, durationMs: 12_000, label: "compaction (cache-shared)" },
			{ at: T + 59_960, durationMs: 40, label: "compaction (cache-shared, early)" },
			{ at: T + 90_000, label: "compaction (standalone)" },
		]);
		expect(events[2]).not.toHaveProperty("durationMs");
	});
});
