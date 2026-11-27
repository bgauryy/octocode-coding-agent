import { describe, expect, it } from "vitest";
import { finalizeCompactionResult } from "../src/core/compaction/checkpoint.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const archivePath = (n: number) => `/sessions/s.jsonl.checkpoint-${n}.md`;

/** A branch holding `count` archived compactions followed by the entry the next compaction keeps. */
function branchWithArchives(count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let n = 0; n < count; n++) {
		entries.push({
			type: "compaction",
			id: `c${n}`,
			parentId: n === 0 ? null : `c${n - 1}`,
			timestamp: new Date(n).toISOString(),
			summary: "s",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
			details: { checkpointArchive: { path: archivePath(n), summary: "full" } },
		});
	}
	entries.push({
		type: "message",
		id: "kept",
		parentId: count === 0 ? null : `c${count - 1}`,
		timestamp: new Date(count).toISOString(),
		message: { role: "user", content: "recent", timestamp: 0 },
	});
	return entries;
}

const noticeText = (summary: string) => summary.split("Earlier complete checkpoints")[1] ?? "";
const listed = (summary: string) => noticeText(summary).match(/\/sessions\/s\.jsonl\.checkpoint-\d+\.md/g) ?? [];

describe("earlier-checkpoints notice", () => {
	const finalize = (count: number) =>
		finalizeCompactionResult(
			{ summary: "## Goal\nx", firstKeptEntryId: "kept", tokensBefore: 1, details: {} },
			{ branchEntries: branchWithArchives(count), contextWindow: 0, reserveTokens: 0 },
		).summary;

	it("lists every earlier checkpoint while there are few", () => {
		expect(listed(finalize(3))).toEqual([archivePath(0), archivePath(1), archivePath(2)]);
	});

	it("stays bounded after many compactions, keeping the newest paths and the count of the rest", () => {
		const summary = finalize(300);
		const paths = listed(summary);
		expect(paths.length).toBeLessThan(20);
		expect(paths.at(-1)).toBe(archivePath(299));
		expect(paths).not.toContain(archivePath(0));
		expect(noticeText(summary)).toContain(String(300 - paths.length));
		expect(summary.length).toBeLessThan(2_000);
	});
});
