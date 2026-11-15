import { type AssistantMessage, fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

const fileGuard = { restore: () => undefined, forget: () => undefined, record: () => undefined } as never;

function addTurns(session: Harness, label: string) {
	for (let i = 0; i < 4; i++) {
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${label} question ${i} ${"x".repeat(8_000)}` }],
			timestamp: Date.now(),
		});
		session.sessionManager.appendMessage(fauxAssistantMessage(`${label} answer ${i}`));
	}
	session.session.refreshContext();
}

it("gives the default summary the previous summary without the sections code appended to it", async () => {
	harness = await createHarness({
		settings: { retry: { enabled: false } },
		models: [{ id: "m", contextWindow: 40_000, maxTokens: 1_000 }],
		compactionPolicy: { keepRecentTokens: 1_000 },
		builtinCompactionFactories: [(api) => void registerCompaction(api, fileGuard)],
	});
	addTurns(harness, "first");
	harness.setResponses([fauxAssistantMessage("## Goal\nFirst checkpoint.")]);
	await harness.session.compact();
	const carried = harness.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
	// The checkpoint carries the user's messages after the model's own text, as code appends them.
	expect(carried?.type === "compaction" ? carried.summary : "").toContain("<user-message>");

	addTurns(harness, "second");
	const requests: TranscriptContext[] = [];
	const rejected = (context: TranscriptContext): AssistantMessage => {
		requests.push(context);
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" });
	};
	const answered = (context: TranscriptContext): AssistantMessage => {
		requests.push(context);
		return fauxAssistantMessage("## Goal\nSecond checkpoint.");
	};
	// The cache-sharing and the standalone requests fail; the default summary is the one that answers.
	harness.setResponses([rejected, rejected, answered]);
	await harness.session.compact();

	expect(requests).toHaveLength(3);
	expect(JSON.stringify(requests[2].messages)).toContain("First checkpoint.");
	expect(JSON.stringify(requests[2].messages)).not.toContain("<user-message>");
});
