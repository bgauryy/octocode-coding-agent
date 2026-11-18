import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

type Internals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
	_runDefaultCompaction: () => Promise<unknown>;
};

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

it("tells extensions an overflow was not recovered when the automatic compaction limit blocks it", async () => {
	const failures: Array<{ reason: string; errorMessage?: string; willRetry: boolean }> = [];
	const harness = await createHarness({
		settings: { retry: { enabled: false } },
		compactionPolicy: { keepRecentTokens: 1 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_compact_failed", (event) => {
					failures.push({ reason: event.reason, errorMessage: event.errorMessage, willRetry: event.willRetry });
				});
			},
		],
	});
	harnesses.push(harness);
	const internals = harness.session as unknown as Internals;
	const summarize = vi.spyOn(internals, "_runDefaultCompaction").mockRejectedValue(new Error("provider unavailable"));
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "old" }],
		timestamp: now - 2000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("old reply"),
		api: harness.getModel().api,
		provider: harness.getModel().provider,
		model: harness.getModel().id,
		timestamp: now - 1000,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	for (let i = 0; i < 3; i++) await internals._runAutoCompaction("threshold", false);
	expect(summarize).toHaveBeenCalledTimes(3);
	failures.length = 0;

	harness.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 900000 tokens > 200000" }),
	]);
	await harness.session.prompt("too big");

	// The failed reply is already out of the context, so the recovery that did not start must be reported like any other.
	expect(harness.session.messages.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(false);
	expect(failures).toEqual([
		{ reason: "overflow", errorMessage: expect.stringContaining("three consecutive failures"), willRetry: false },
	]);
	expect(harness.session.lastRunOutcome?.status).toBe("failed");
});
