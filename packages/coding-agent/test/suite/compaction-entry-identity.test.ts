import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { createHarness } from "./harness.ts";

it.each(["manual", "threshold", "overflow"] as const)(
	"emits the newly saved %s compaction when summaries repeat",
	async (reason) => {
		const emitted: string[] = [];
		const harness = await createHarness({
			compactionPolicy: { keepRecentTokens: 1 },
			builtinCompactionFactories: [
				(api) => {
					api.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Repeated summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					api.on("session_compact", async (event) => {
						emitted.push(event.compactionEntry.id);
					});
				},
			],
		});
		try {
			for (let round = 0; round < 2; round++) {
				harness.sessionManager.appendMessage({ role: "user", content: `Turn ${round}`, timestamp: Date.now() });
				harness.sessionManager.appendMessage(fauxAssistantMessage("Answer to summarize"));
				harness.session.refreshContext();
				if (reason === "manual") await harness.session.compact();
				else
					await (
						harness.session as unknown as {
							_runAutoCompaction(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean>;
						}
					)._runAutoCompaction(reason, reason === "overflow");
			}
			const saved = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			expect(saved).toHaveLength(2);
			expect(emitted).toEqual(saved.map((entry) => entry.id));
		} finally {
			harness.cleanup();
		}
	},
);
