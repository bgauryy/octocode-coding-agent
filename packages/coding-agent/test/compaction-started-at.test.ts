import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";

it("records when a compaction run started in the entry's details", async () => {
	const manager = SessionManager.inMemory();
	const harness = await createHarness({
		sessionManager: manager,
		models: [{ id: "small", contextWindow: 8000 }],
		tools: [],
		compactionPolicy: { keepRecentTokens: 1 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "Checkpoint",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: { custom: true },
					},
				}));
			},
		],
	});
	try {
		manager.appendMessage({ role: "user", content: "Keep this instruction", timestamp: 0 });
		manager.appendMessage(fauxAssistantMessage("Answer"));
		harness.session.refreshContext();
		const before = Date.now();
		await harness.session.compact();
		const entry = manager.getBranch().find((candidate) => candidate.type === "compaction");
		if (entry?.type !== "compaction") throw new Error("no compaction entry");
		const details = entry.details as { custom: boolean; startedAt: string };
		expect(details.custom).toBe(true);
		const started = Date.parse(details.startedAt);
		expect(started).toBeGreaterThanOrEqual(before);
		expect(started).toBeLessThanOrEqual(Date.parse(entry.timestamp));
	} finally {
		harness.cleanup();
	}
});
