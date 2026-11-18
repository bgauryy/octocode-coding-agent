import { describe, expect, it, vi } from "vitest";
import {
	COMPACT_RESUME_TEXT,
	COMPACT_RESUME_TYPE,
	CompactRequests,
} from "../../src/octocode/native/tools/compact/tool.ts";
import { ThrashBreaker } from "../../src/octocode/compaction/pacing.ts";

/** One requested compaction that settles, with `compact` ending as `outcome`; returns what the session was sent. */
function settle(hasUI: boolean, outcome: "complete" | "fail") {
	const requests = new CompactRequests(new ThrashBreaker());
	requests.request("keep the marker");
	const sendMessage = vi.fn();
	const compact = vi.fn((options: { onComplete: () => void; onError: (error: Error) => void }) =>
		outcome === "complete" ? options.onComplete() : options.onError(new Error("Nothing to compact")),
	);
	requests.settle({ session: { sendMessage } }, { compact, hasUI }, false);
	return { requests, sendMessage, compact };
}

describe("a requested compaction that settles", () => {
	it("passes the focus and resumes the task from the summary with a turn", () => {
		const { compact, sendMessage, requests } = settle(false, "complete");
		expect(compact).toHaveBeenCalledWith(expect.objectContaining({ customInstructions: "keep the marker" }));
		expect(sendMessage).toHaveBeenCalledWith(
			{ customType: COMPACT_RESUME_TYPE, content: COMPACT_RESUME_TEXT, display: false },
			{ triggerTurn: true },
		);
		expect(requests.inFlight).toBe(false);
	});

	it("tells a headless run that the compaction did not run, and starts the turn it would not otherwise get", () => {
		const { sendMessage } = settle(false, "fail");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("did not run: Nothing to compact") }),
			{ triggerTurn: true },
		);
	});

	it("tells an interactive session without starting a turn: the user already saw the failure", () => {
		const { sendMessage } = settle(true, "fail");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("did not run") }),
			{ triggerTurn: false },
		);
	});
});
