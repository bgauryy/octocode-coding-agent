import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { compactionStopTokens } from "../../../src/core/compaction/boundary-stop.ts";
import { shouldCompact, shouldStopForCompaction } from "../../../src/core/compaction/index.ts";
import { MONITOR_DEFAULTS } from "../../../src/core/settings-schema/monitor.ts";
import { noticeBand } from "../../../src/octocode/monitor/attention/context.ts";
import { Mail } from "../../../src/octocode/team/mail.ts";
import type { AgentEvent } from "../../../src/octocode/wake/catalog.ts";
import { branchLines, count, createRig, wakeGateOf, type Rig } from "./rig.ts";
import { gateSummary } from "./summary-gate.ts";

/**
 * RFC agent-event-loop R5: the nudge at 90% of the compaction limit (window minus reserve) and the stop at 90% of the window
 * (at most the limit), at a step
 * boundary; compaction then continues the task; events queue behind it; only the user's Stop cancels it.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

const settings = { enabled: true, reserveTokens: 400, keepRecentTokens: 1000 };
const WAKE = "WAKE-DURING-STOP";
const exit = (job: string): AgentEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });

describe("the marks of the compaction limit", () => {
	it("nudges once the context reaches 90% of window minus reserve and stops at 90% of the window", () => {
		const window = 8000;
		const limit = window - settings.reserveTokens;
		expect(noticeBand(0.89 * limit, limit)).toBeUndefined();
		expect(noticeBand(0.9 * limit, limit)).toBe(0.9);
		expect(MONITOR_DEFAULTS.contextBands).toEqual([0.9]);
		expect(compactionStopTokens(window, settings)).toBe(0.9 * window);
		expect(shouldStopForCompaction(0.9 * window - 1, window, settings)).toBe(false);
		expect(shouldStopForCompaction(0.9 * window, window, settings)).toBe(true);
		// The post-run check reads the same first point.
		expect(shouldCompact(0.9 * window - 1, window, settings)).toBe(false);
		expect(shouldCompact(0.9 * window + 1, window, settings)).toBe(true);
		expect(shouldStopForCompaction(0.99 * limit, 0, settings)).toBe(false);
		expect(shouldStopForCompaction(0.99 * limit, 8000, { ...settings, enabled: false })).toBe(false);
	});

	it("stops at the threshold when the reserve leaves less than 90% of the window", () => {
		const window = 3200;
		const limit = window - settings.reserveTokens;
		expect(limit).toBeLessThan(0.9 * window);
		expect(compactionStopTokens(window, settings)).toBe(limit);
		expect(shouldStopForCompaction(limit - 1, window, settings)).toBe(false);
		expect(shouldStopForCompaction(limit, window, settings)).toBe(true);
	});
});

const bigResult: AgentTool = {
	name: "large_result",
	label: "large_result",
	description: "Returns enough content to cross 90% of the window, not the compaction limit",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: `big:${"x".repeat(6080)}` }], details: {} }),
};

/** A small reserve, so the stop sits below the threshold. */
const midRunSettings = { ...settings, reserveTokens: 200 };

/** A 3200-token window, limit 3000, stop at 2880: the first tool result lands between the stop and the limit. */
async function midRun() {
	const rig = await createRig({
		models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
		compactionPolicy: midRunSettings,
		tools: [bigResult],
		// No window: these cases are about compaction, not about how long the loop holds a wake.
		settings: { runtime: { eventWindowSeconds: 0 } },
	});
	rigs.push(rig);
	rig.harness.setResponses([
		fauxAssistantMessage(`old:${"a".repeat(800)}`),
		fauxAssistantMessage(`recent:${"b".repeat(800)}`),
		fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
		rig.reply("turn A"),
		rig.reply("turn B"),
	]);
	await rig.harness.session.prompt("seed old");
	await rig.harness.session.prompt("seed recent");
	rig.requests.length = 0;
	return rig;
}

describe("the hard stop at a step boundary", () => {
	it("compacts between the tool call and the next request at 90% of the window, then continues the task", async () => {
		const rig = await midRun();
		const gate = gateSummary(rig.harness.session);
		const running = rig.harness.session.prompt("run the tool");
		await gate.started;
		// The tool finished (its result is in the branch) before the compaction began: never mid-tool.
		expect(branchLines(rig.harness).some((line) => line.includes("big:"))).toBe(true);
		expect(rig.requests).toHaveLength(0);
		gate.release();
		await running;
		await rig.harness.session.waitForIdle();
		const branch = branchLines(rig.harness);
		expect(branch).toContain("compaction");
		// The model's next request came after the summary and the run ended with its answer.
		expect(rig.requests).toHaveLength(1);
		expect(rig.requests[0].some((line) => line.includes("The conversation history"))).toBe(true);
		expect(branch.at(-1)).toContain("turn A");
	});

	it("queues an event that arrives during that compaction and delivers it once, after it", async () => {
		const rig = await midRun();
		const gate = gateSummary(rig.harness.session);
		const running = rig.harness.session.prompt("run the tool");
		await gate.started;
		expect(rig.harness.session.isCompacting).toBe(true);
		await wakeGateOf(rig.api).emit(
			exit("bash-9"),
			{ customType: "loop-test", content: WAKE, display: true },
			{ triggerTurn: true, deliverAs: "followUp", together: true },
		);
		expect(rig.requests).toHaveLength(0);
		gate.release();
		await running;
		await rig.harness.session.waitForIdle();
		const branch = branchLines(rig.harness);
		expect(count(branch, WAKE)).toBe(1);
		expect(branch.findIndex((line) => line.includes(WAKE))).toBeGreaterThan(branch.indexOf("compaction"));
		expect(rig.harness.session.agent.hasQueuedMessages()).toBe(false);
	});
});

describe("who cancels a running compaction", () => {
	const peerMail = {
		id: 1,
		from: "parent-1",
		to: "me",
		text: "PEER-INTERRUPT",
		at: 1,
		replyRequired: false,
		interrupt: true,
		wake: true,
	};

	it("a peer's interrupt does not cancel it: the summary is saved, the mail arrives after it", async () => {
		const rig = await midRun();
		const gate = gateSummary(rig.harness.session);
		const running = rig.harness.session.prompt("run the tool");
		await gate.started;
		const mail = new Mail(rig.api);
		mail.deliver([peerMail], "parent-1", rig.ctx);
		gate.release();
		await running.catch(() => undefined);
		// The run settled: the held interrupt starts the next turn, behind the saved summary.
		expect(mail.settled()).toBe(true);
		await rig.harness.session.waitForIdle();
		const branch = branchLines(rig.harness);
		expect(gate.requests()).toBeGreaterThanOrEqual(1);
		expect(branch).toContain("compaction");
		expect(count(branch, "PEER-INTERRUPT")).toBe(1);
	});

	it("the user's Stop does: no summary is saved", async () => {
		const rig = await midRun();
		const gate = gateSummary(rig.harness.session);
		const running = rig.harness.session.prompt("run the tool");
		await gate.started;
		await rig.harness.session.abort();
		await running.catch(() => undefined);
		await rig.harness.session.waitForIdle();
		expect(branchLines(rig.harness)).not.toContain("compaction");
		expect(rig.harness.session.isCompacting).toBe(false);
	});
});

describe("one first compaction point", () => {
	it("is the same for the footer, /context and the loop's stop at a 1M window", async () => {
		const { autoCompactAt } = await import("../../../src/octocode/shared/tokens.ts");
		const { compactionThresholdTokens } = await import("../../../src/core/compaction/settings.ts");
		const window = 1_000_000;
		const big = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
		const model = { provider: "p", id: "m", contextWindow: window };
		const stop = compactionStopTokens(window, big);
		expect(stop).toBe(0.9 * window);
		expect(compactionThresholdTokens(window, big)).toBe(stop);
		expect(autoCompactAt(model)).toBe(stop);
		expect(shouldCompact(stop - 1, window, big)).toBe(false);
		expect(shouldCompact(stop + 1, window, big)).toBe(true);
	});
});
