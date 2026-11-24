import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/octocode/wake/catalog.ts";
import { branchLines, count, createRig, expectExitQueued, wakeGateOf, type Rig } from "./rig.ts";
import { gateSummary } from "./summary-gate.ts";

/**
 * What happens to a wake event that arrives while a compaction runs (RFC agent-event-loop R0, §7). Automatic compaction
 * has three entry points that do not share code:
 *   - before a run starts: `prepareRun` → `checkCompaction` (core/agent-session/run-loop.ts:205);
 *   - after a run ended: `_handlePostAgentRun` → `checkCompaction` (run-loop.ts:282);
 *   - between two model requests of one run: `prepareRequest` / `prepareNextTurnWithContext`
 *     (core/agent-session/agent-hooks.ts:215, :288), which never call `checkCompaction`.
 * Manual `/compact` holds input through `isManualRunning` (core/agent-session/prompting.ts:208).
 * Every case pins today's delivery: after the summary, never inside it. R5/R7 may move it on purpose.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

const exit = (job: string): AgentEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });
const WAKE = "WAKE-DURING-COMPACTION";
const DELIVERIES = ["steer", "followUp"] as const;
type Script = Parameters<Rig["harness"]["setResponses"]>[0];
type Delivery = (typeof DELIVERIES)[number];
const send = (rig: Rig, deliverAs: Delivery) =>
	wakeGateOf(rig.api).emit(
		exit("bash-9"),
		{ customType: "loop-test", content: WAKE, display: true },
		{ triggerTurn: true, deliverAs, together: true },
	);

/** A window of 8,000 tokens (threshold 7,600) and four seeded turns that leave the context at about 6,500 tokens. */
async function seeded(responses: (rig: Rig) => Script) {
	const rig = await createRig({
		models: [{ id: "faux-1", contextWindow: 8000, maxTokens: 100 }],
		compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
	});
	rigs.push(rig);
	rig.harness.setResponses([
		fauxAssistantMessage(`s1:${"a".repeat(7500)}`),
		fauxAssistantMessage(`s2:${"b".repeat(7500)}`),
		fauxAssistantMessage(`s3:${"c".repeat(7500)}`),
		fauxAssistantMessage(`s4:${"d".repeat(1500)}`),
		...responses(rig),
	]);
	for (const turn of ["s1", "s2", "s3", "s4"]) await rig.harness.session.prompt(`seed ${turn}`);
	rig.requests.length = 0;
	return rig;
}

/** The compaction entry comes first, then the wake message, once; nothing is left queued. */
function expectAfterSummary(rig: Rig) {
	expectAfterSummaryOf(rig, WAKE);
}
function expectAfterSummaryOf(rig: Rig, text: string) {
	const branch = branchLines(rig.harness);
	const compaction = branch.indexOf("compaction");
	expect(compaction).toBeGreaterThan(-1);
	expect(branch.findIndex((line) => line.includes(text))).toBeGreaterThan(compaction);
	expect(count(branch, text)).toBe(1);
	expect(rig.harness.session.agent.hasQueuedMessages()).toBe(false);
	expect(rig.harness.session.isCompacting).toBe(false);
}

describe("an event during the automatic compaction after a run (run-loop.ts:282)", () => {
	it.each(DELIVERIES)("holds a %s wake behind the summary and delivers it once, after it", async (deliverAs) => {
		const rig = await seeded((r) => [
			fauxAssistantMessage(`big:${"e".repeat(5000)}`),
			r.reply("turn A"),
			r.reply("turn B"),
		]);
		const gate = gateSummary(rig.harness.session);
		const running = rig.harness.session.prompt("go big");
		await gate.started;
		// The run ended; the session still reports it busy, so the event queues instead of starting a run.
		expect(rig.harness.session.isStreaming).toBe(true);
		expect(rig.harness.session.isCompacting).toBe(true);
		await send(rig, deliverAs);
		expectExitQueued(rig);
		expect(rig.requests).toHaveLength(0);
		gate.release();
		await running;
		await rig.harness.session.waitForIdle();
		expectAfterSummary(rig);
		// Exactly one turn answered it, and the request already held the summary.
		expect(rig.requests).toHaveLength(1);
		expect(count(rig.requests[0], WAKE)).toBe(1);
		expect(rig.requests[0].some((line) => line.includes("The conversation history"))).toBe(true);
	});
});

describe("an event during the automatic compaction before a run (run-loop.ts:205)", () => {
	it.each(DELIVERIES)("holds a %s wake behind the summary and delivers it once, after it", async (deliverAs) => {
		const rig = await seeded((r) => [r.reply("answer"), r.reply("turn A"), r.reply("turn B")]);
		const gate = gateSummary(rig.harness.session);
		// The prompt alone pushes the context over the threshold, so it waits for the summary.
		const running = rig.harness.session.prompt(`go ${"x".repeat(6000)}`);
		await gate.started;
		expect(rig.requests).toHaveLength(0);
		expect(rig.harness.session.isCompacting).toBe(true);
		await send(rig, deliverAs);
		expect(rig.requests).toHaveLength(0);
		gate.release();
		await running;
		await rig.harness.session.waitForIdle();
		expectAfterSummary(rig);
		expect(count(rig.requests.flat(), WAKE)).toBeGreaterThanOrEqual(1);
	});
});

const bigResult: AgentTool = {
	name: "large_result",
	label: "large_result",
	description: "Returns enough content to cross the compaction threshold",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: `big:${"x".repeat(5200)}` }], details: {} }),
};

async function midRun() {
	const rig = await createRig({
		models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
		compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 1000 },
		tools: [bigResult],
	});
	rigs.push(rig);
	rig.harness.setResponses([
		fauxAssistantMessage(`old:${"a".repeat(800)}`),
		fauxAssistantMessage(`recent:${"b".repeat(800)}`),
		fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
		rig.reply("turn A"),
		rig.reply("turn B"),
		rig.reply("turn C"),
	]);
	await rig.harness.session.prompt("seed old");
	await rig.harness.session.prompt("seed recent");
	return rig;
}

describe("an event during the automatic compaction between two requests of one run (agent-hooks.ts:215, :288)", () => {
	it.each(DELIVERIES)("holds a %s wake behind the summary and delivers it once, after it", async (deliverAs) => {
		const rig = await midRun();
		const gate = gateSummary(rig.harness.session);
		const running = rig.harness.session.prompt("run the tools");
		await gate.started;
		expect(rig.harness.session.isCompacting).toBe(true);
		await send(rig, deliverAs);
		expectExitQueued(rig);
		gate.release();
		await running;
		await rig.harness.session.waitForIdle();
		expectAfterSummary(rig);
	});
});

describe("an event during a manual /compact (prompting.ts:208)", () => {
	it.each(DELIVERIES)("holds a %s wake and starts one turn with it when the summary is saved", async (deliverAs) => {
		const rig = await seeded((r) => [r.reply("turn A"), r.reply("turn B")]);
		const gate = gateSummary(rig.harness.session);
		const compacting = rig.harness.session.compact();
		await gate.started;
		expect(rig.harness.session.isCompacting).toBe(true);
		await send(rig, deliverAs);
		expect(rig.requests).toHaveLength(0);
		gate.release();
		await compacting;
		await rig.harness.session.waitForIdle();
		expectAfterSummary(rig);
		expect(rig.requests).toHaveLength(1);
		expect(count(rig.requests[0], WAKE)).toBe(1);
	});

	it("records the job without waking the session after the user stops compaction", async () => {
		const rig = await seeded((r) => [r.reply("unexpected wake")]);
		const pending = gateSummary(rig.harness.session);
		const compacting = rig.harness.session.compact();
		const cancelled = expect(compacting).rejects.toThrow(/cancel|abort/i);
		await pending.started;
		await send(rig, "steer");
		await rig.harness.session.abort("interrupted");
		await cancelled;
		await rig.harness.session.waitForIdle();
		expect(count(branchLines(rig.harness), WAKE)).toBe(1);
		expect(rig.requests).toHaveLength(0);
	});

	it("also delivers after a failed summary: the wake is not lost with it", async () => {
		const rig = await seeded((r) => [r.reply("turn A")]);
		const gate = gateSummary(rig.harness.session);
		const compacting = rig.harness.session.compact().catch(() => undefined);
		await gate.started;
		await send(rig, "followUp");
		gate.fail("summarizer exploded");
		await compacting;
		await rig.harness.session.waitForIdle();
		const branch = branchLines(rig.harness);
		expect(branch).not.toContain("compaction");
		expect(count(branch, WAKE)).toBe(1);
		expect(rig.requests).toHaveLength(1);
	});
});

describe("the threshold path after a run (run-loop.ts:282, compaction-check.ts:97-98)", () => {
	it("compacts and stops: no auto-continue request follows (R5 adds `compaction.resume`)", async () => {
		const rig = await seeded((r) => [fauxAssistantMessage(`big:${"e".repeat(5000)}`), r.reply("must not be consumed")]);
		const gate = gateSummary(rig.harness.session);
		gate.release();
		await rig.harness.session.prompt("go big");
		await rig.harness.session.waitForIdle();
		expect(branchLines(rig.harness)).toContain("compaction");
		expect(rig.requests).toHaveLength(0);
		expect(rig.harness.getPendingResponseCount()).toBe(1);
		expect(rig.harness.session.isStreaming).toBe(false);
	});
});
