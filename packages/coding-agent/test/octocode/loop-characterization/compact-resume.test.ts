import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it, vi } from "vitest";
import { ThrashBreaker } from "../../../src/octocode/compaction/pacing.ts";
import {
	COMPACT_RESUME_TYPE,
	COMPACT_RESUME_TEXT,
	CompactRequests,
} from "../../../src/octocode/native/tools/compact/tool.ts";
import { count, createRig, expectExitQueued, wakeGateOf } from "./rig.ts";
import { gateSummary } from "./summary-gate.ts";

it.each([
	{ jobs: 0, failure: false },
	{ jobs: 1, failure: false },
	{ jobs: 256, failure: false },
	{ jobs: 1, failure: true },
	{ jobs: 256, failure: true },
])(
	"sends the compact outcome and $jobs waiting jobs in one request (summary failed: $failure)",
	async ({ jobs, failure }) => {
		const compact = new CompactRequests(new ThrashBreaker());
		const rig = await createRig({
			models: [{ id: "faux-1", contextWindow: 8000, maxTokens: 100 }],
			compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
			register: (api) => {
				api.bus.on("agent_settled", (event, ctx) => compact.settle(api, ctx, event.aborted));
			},
		});
		const { session, sessionManager } = rig.harness;
		const summary = gateSummary(session);
		try {
			rig.harness.setResponses([
				fauxAssistantMessage("first " + "a".repeat(3000)),
				fauxAssistantMessage("second " + "b".repeat(3000)),
				fauxAssistantMessage("Compacting after this reply."),
				rig.reply("resumed"),
				rig.reply("unexpected extra request"),
			]);
			await session.prompt("first task");
			await session.prompt("second task");
			compact.request("finish the task");
			const running = session.prompt("continue");
			await summary.started;
			const ids = Array.from({ length: jobs }, (_, i) => `JOB-READY-${i}!`);
			for (const job of ids)
				await wakeGateOf(rig.api).emit(
					{ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 },
					{ customType: "job", content: job, display: true },
					{ triggerTurn: true },
				);
			if (jobs) expectExitQueued(rig);
			if (failure) summary.fail("summary unavailable");
			else summary.release("Summary of the work");
			await running;
			await session.settled();
			await vi.waitFor(() =>
				expect(
					sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "job"),
				).toHaveLength(jobs),
			);
			await session.waitForIdle();
			await session.settled();
			expect(rig.requests).toHaveLength(1);
			const note = failure ? "summary unavailable" : COMPACT_RESUME_TEXT;
			expect(count(rig.requests[0], note)).toBe(1);
			for (const id of ids) expect(count(rig.requests[0], id)).toBe(1);
			expect(
				sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === COMPACT_RESUME_TYPE),
			).toEqual([expect.objectContaining({ display: false, content: expect.stringContaining(note) })]);
		} finally {
			summary.release();
			await session.abort();
			rig.cleanup();
		}
	},
);
