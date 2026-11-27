import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compact, prepareCompaction } from "../src/core/compaction/index.ts";
import { builtInCompactionSettings } from "../src/core/compaction/settings.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	parseSessionEntries,
	type SessionEntry,
} from "../src/core/session-manager.ts";

// Paid: real Anthropic requests. Runs only through `yarn test:live` with ANTHROPIC_API_KEY exported.
const DEFAULT_COMPACTION_SETTINGS = builtInCompactionSettings();

function loadLargeSessionEntries(): SessionEntry[] {
	const content = readFileSync(join(__dirname, "fixtures/large-session.jsonl"), "utf-8");
	return parseSessionEntries(content).filter((e): e is SessionEntry => e.type !== "session");
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = loadLargeSessionEntries();
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_API_KEY);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_API_KEY);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});
