import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

it.each(["manual", "threshold", "overflow"] as const)(
	"preserves projected history when a %s compaction extension returns an empty summary",
	async (reason) => {
		const harness = await createHarness({
			tools: [],
			compactionPolicy: { keepRecentTokens: 1 },
			builtinCompactionFactories: [
				(api) => {
					api.on("session_before_compact", async (event) => ({
						compaction: {
							summary: " \n\t",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		try {
			const manager = harness.sessionManager;
			manager.appendMessage({ role: "user", content: "Preserve this objective", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("Keep this evidence"));
			harness.session.refreshContext();
			const before = manager.getBranch();
			const projection = manager.buildSessionProjection();
			if (reason === "manual") await expect(harness.session.compact()).rejects.toThrow("the summary was empty");
			else {
				const session = harness.session as unknown as {
					_runAutoCompaction(reason: "threshold" | "overflow", retry: boolean): Promise<boolean>;
				};
				expect(await session._runAutoCompaction(reason, reason === "overflow")).toBe(false);
			}
			expect(manager.getBranch()).toEqual(before);
			expect(manager.buildSessionProjection()).toEqual(projection);
			expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			harness.cleanup();
		}
	},
);
