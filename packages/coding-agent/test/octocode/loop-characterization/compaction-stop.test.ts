import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { shouldCompact, shouldStopForCompaction } from "../../../src/core/compaction/index.ts";
import { MONITOR_DEFAULTS } from "../../../src/core/settings-schema/monitor.ts";
import { noticeBand } from "../../../src/octocode/monitor/attention/context.ts";
import { Mail } from "../../../src/octocode/team/mail.ts";
import type { AgentEvent } from "../../../src/octocode/wake/catalog.ts";
import { branchLines, count, createRig, wakeGateOf, type Rig } from "./rig.ts";
import { gateSummary } from "./summary-gate.ts";

/**
 * RFC agent-event-loop R5: the nudge at 90% and the stop at 95% of the compaction limit (window minus reserve), at a step
 * boundary; compaction then continues the task; events queue behind it; only the user's Stop cancels it.
 * The stop is the `new` mode's; the nudge is the context-usage band that exists today.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

const settings = { enabled: true, reserveTokens: 400, keepRecentTokens: 1000 };
const WAKE = "WAKE-DURING-STOP";
const exit = (job: string): AgentEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });

describe("the marks of the compaction limit", () => {
	it("nudges once the context reaches 90% and stops at 95%, both of window minus reserve", () => {
		const limit = 8000 - settings.reserveTokens;
		expect(noticeBand(0.89 * limit, limit)).toBeLessThan(0.9);
		expect(noticeBand(0.9 * limit, limit)).toBe(0.9);
		expect(MONITOR_DEFAULTS.contextBands.at(-1)).toBe(0.9);
		expect(shouldStopForCompaction(0.94 * limit, 8000, settings)).toBe(false);
		expect(shouldStopForCompaction(0.95 * limit, 8000, settings)).toBe(true);
		// The old threshold stays the backstop.
		expect(shouldCompact(0.95 * limit, 8000, settings)).toBe(false);
		expect(shouldStopForCompaction(0.99 * limit, 0, settings)).toBe(false);
		expect(shouldStopForCompaction(0.99 * limit, 8000, { ...settings, enabled: false })).toBe(false);
	});
});

const bigResult: AgentTool = {
	name: "large_result",
	label: "large_result",
	description: "Returns enough content to cross 95% of the compaction limit, not 100%",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: `big:${"x".repeat(5200)}` }], details: {} }),
};

/** A 3200-token window, limit 2800, stop at 2660: the first tool result lands between the stop and the limit. */
async function midRun(mode: "old" | "new") {
	const rig = await createRig({
		models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
		compactionPolicy: settings,
		tools: [bigResult],
		// No window: these cases are about compaction, not about how long the loop holds a wake.
		settings: { runtime: { eventLoop: mode, eventWindowSeconds: 0 } },
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
	it("compacts between the tool call and the next request at 95%, then continues the task", async () => {
		const rig = await midRun("new");
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

	it("leaves 95% to the limit in the old mode: no compaction in that run", async () => {
		const rig = await midRun("old");
		await rig.harness.session.prompt("run the tool");
		await rig.harness.session.waitForIdle();
		expect(branchLines(rig.harness).filter((line) => line === "compaction").length).toBeLessThanOrEqual(1);
		expect(rig.requests[0]?.some((line) => line.includes("The conversation history"))).toBe(false);
	});

	it("queues an event that arrives during that compaction and delivers it once, after it", async () => {
		const rig = await midRun("new");
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
		const rig = await midRun("new");
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
		const rig = await midRun("new");
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
