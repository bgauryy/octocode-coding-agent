import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

type Internals = { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean> };

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function harnessWhoseHookReturns(result: { cancel: true; failure?: string }) {
	const calls: number[] = [];
	const harness = await createHarness({
		compactionPolicy: { keepRecentTokens: 1 },
		builtinCompactionFactories: [
			(pi) => {
				pi.on("session_before_compact", async () => {
					calls.push(calls.length);
					return result;
				});
			},
		],
	});
	harnesses.push(harness);
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		api: harness.getModel().api,
		provider: harness.getModel().provider,
		model: harness.getModel().id,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return { harness, calls };
}

describe("a compaction hook that reports a failure", () => {
	it("counts toward the automatic failure limit, with its own text as the error, instead of cancelling silently", async () => {
		const { harness, calls } = await harnessWhoseHookReturns({
			cancel: true,
			failure: "Cannot persist the checkpoint",
		});
		const internals = harness.session as unknown as Internals;
		for (let i = 0; i < 5; i++) await internals._runAutoCompaction("overflow", true);
		expect(calls).toHaveLength(3);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends[0]).toMatchObject({
			aborted: false,
			errorMessage: "Context overflow recovery failed: Cannot persist the checkpoint",
		});
		expect(ends.at(-1)?.errorMessage).toContain("three consecutive failures");
		expect(harness.eventsOfType("compaction_end").some((event) => event.aborted)).toBe(false);
	});

	it("still treats a plain cancel as the user's, which never counts", async () => {
		const { harness, calls } = await harnessWhoseHookReturns({ cancel: true });
		const internals = harness.session as unknown as Internals;
		for (let i = 0; i < 5; i++) await internals._runAutoCompaction("threshold", false);
		expect(calls).toHaveLength(5);
		expect(harness.eventsOfType("compaction_end").every((event) => event.aborted)).toBe(true);
	});
});
