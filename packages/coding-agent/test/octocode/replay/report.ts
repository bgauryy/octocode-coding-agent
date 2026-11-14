import type { ReplayResult } from "./run.ts";

/** The replay's numbers, as one line for a test log and as a Markdown report for a local run. */

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function replayLine(result: ReplayResult): string {
	const { model, timing } = result;
	return (
		`replay ${result.name}: ${result.turnsDone}/${result.recording.turns} turns, ${model.requests} requests ` +
		`(${model.summaryRequests} summaries), ${result.compactions.count} compactions at a ${result.contextWindow}-token window, ` +
		`summary chars [${result.compactions.summaryChars.join(", ")}], peak prompt ${result.profiler.peakPromptTokens} tokens, ` +
		`turn ms p50/p95/max ${timing.turnMs.p50}/${timing.turnMs.p95}/${timing.turnMs.max}, ` +
		`loop delay p99/max ${timing.loop.p99Ms}/${timing.loop.maxMs} ms, stalls ${result.profiler.stalls}, ` +
		`heap peak ${mb(timing.heapPeakBytes)}, file ${result.file.bytes} B, mirror ${result.mirror.byteSize} B, ${timing.seconds} s`
	);
}

const row = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`;
const list = (items: readonly string[], none = "none") =>
	items.length === 0 ? none : items.map((item) => `\n  - ${item}`).join("");

export function replayMarkdown(result: ReplayResult): string {
	const { recording, model, tools, timing, profiler } = result;
	const recovered = result.recovery.map(
		(row) =>
			`${row.compaction}: ${row.before} before, ${row.inline} inline, ${row.referenced} by reference, ` +
			`${row.transcript} in the transcript, ${row.lost.length} lost`,
	);
	return [
		`# Session replay: ${result.name}`,
		"",
		"## Recording",
		"",
		row(["Measure", "Value"]),
		row(["---", "---"]),
		row(["File", `${mb(recording.bytes)}, ${recording.entries} entries on the active branch`]),
		row(["Turns / replies", `${recording.turns} / ${recording.replies}`]),
		row(["Recorded summaries", recording.summaries]),
		row(["Tools", recording.toolNames.join(", ")]),
		row(["Recorded usage (original prompt)", JSON.stringify(recording.recordedUsage)]),
		row(["Left out", JSON.stringify(recording.skipped)]),
		"",
		"## Replay",
		"",
		row(["Measure", "Value"]),
		row(["---", "---"]),
		row(["Window", `${result.contextWindow} tokens`]),
		row(["Turns done", `${result.turnsDone}, idle at the end: ${result.finalIdle}`]),
		row([
			"Requests",
			`${model.requests} (${model.summaryRequests} summaries, ${model.recordedSummariesUsed} from the recording)`,
		]),
		row(["Compactions", `${result.compactions.count}; tokens before [${result.compactions.tokensBefore.join(", ")}]`]),
		row(["Summary chars", `[${result.compactions.summaryChars.join(", ")}]`]),
		row(["Context chars after each compaction", `[${model.contextAfterCompaction.join(", ")}]`]),
		row(["Peak prompt", `${profiler.peakPromptTokens} tokens (${model.peakContextChars} provider chars)`]),
		row(["Clearings", `${model.clearings}`]),
		row([
			"System prompts / tool arrays per segment",
			`[${model.systemsPerSegment.join(", ")}] / [${model.toolArraysPerSegment.join(", ")}]`,
		]),
		row(["Run tails / unanswered prompts", `${model.runTails} / ${model.unanswered}`]),
		row([
			"Tool calls",
			`${tools.ended} ended, ${tools.replayed} replayed, ${tools.errors} errors, ${tools.notRecorded.length} not recorded`,
		]),
		row(["Projection after reopening", result.projectionStable ? "identical" : "different"]),
		row([
			"File / mirror",
			`${result.file.bytes} B, ${result.file.lines} lines / ${result.mirror.byteSize} B, ${result.mirror.records} records`,
		]),
		row(["Phases on tool results", `${profiler.withPhases}/${profiler.toolResults}`]),
		row(["First-token time on replies", `${profiler.withFirstToken}/${profiler.replies}`]),
		row(["Stall entries", `${profiler.stalls} (max ${profiler.maxStallMs} ms)`]),
		"",
		"## Time and memory",
		"",
		row(["Measure", "Value"]),
		row(["---", "---"]),
		row(["Wall time", `${timing.seconds} s`]),
		row(["Turn ms p50 / p95 / max", `${timing.turnMs.p50} / ${timing.turnMs.p95} / ${timing.turnMs.max}`]),
		row([
			"Event-loop delay p50 / p95 / p99 / max",
			`${timing.loop.p50Ms} / ${timing.loop.p95Ms} / ${timing.loop.p99Ms} / ${timing.loop.maxMs} ms`,
		]),
		row([
			"GC",
			`${timing.gc.count} pauses, ${timing.gc.totalMs} ms total, max ${timing.gc.maxMs} ms, ${JSON.stringify(timing.gc.byKind)}`,
		]),
		row(["Heap / RSS peak", `${mb(timing.heapPeakBytes)} / ${mb(timing.rssPeakBytes)}`]),
		"",
		"Slowest turns:",
		"",
		row(["Turn", "ms", "Loop max ms", "Requests", "Compactions"]),
		row(["---", "---", "---", "---", "---"]),
		...timing.slowTurns.map((turn) => row([turn.turn, turn.ms, turn.loopMaxMs, turn.requests, turn.compactions])),
		"",
		"## Findings",
		"",
		`- System message changes inside a segment: ${list(model.systemChanges)}`,
		`- Prefix breaks: ${list(model.prefixBreaks)}`,
		`- Messages changed in place: ${list(model.changedInPlace)}`,
		`- Diverged requests: ${list(model.diverged)}`,
		`- Unscripted requests: ${list(model.unscripted)}`,
		`- Prompt errors: ${list(result.promptErrors)}`,
		`- Failed runs: ${list(result.failedRuns)}`,
		`- Replies never requested: ${list(result.leftovers)}`,
		`- Tool calls without a recorded result: ${list(tools.notRecorded)}`,
		`- Tool calls refused before they ran: ${list(tools.refused)}`,
		`- Persistence failures: ${list(result.persistenceFailures)}`,
		`- User messages after each compaction: ${list(recovered)}`,
		...result.recovery.flatMap((row) =>
			row.lost.length > 0 ? [`  - lost after ${row.compaction}: ${list(row.lost)}`] : [],
		),
		`- Profiles: ${list(result.profiles)}`,
		"",
	].join("\n");
}
