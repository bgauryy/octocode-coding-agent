import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { carriedRecords } from "../../src/octocode/compaction/saved-results.ts";

describe("carrying records after repeated default compactions", () => {
	it("indexes branch identities once while recovering every summarized stretch", () => {
		let visits = 0;
		const entries: unknown[] = [];
		for (let index = 0; index < 240; index++) {
			for (const entry of [
				{ id: `m${index}`, type: "message", message: { role: "user", content: `request ${index}` } },
				{ id: `c${index}`, type: "compaction", firstKeptEntryId: `c${index}` },
			]) {
				const { id } = entry;
				entries.push(
					Object.defineProperty(entry, "id", {
						get: () => {
							visits++;
							return id;
						},
					}),
				);
			}
		}
		const { recorded, stretches } = carriedRecords(entries as SessionEntry[], "loadedSkills");
		expect(recorded).toEqual([]);
		expect(stretches.flat().filter(Boolean)).toEqual(
			Array.from({ length: 240 }, (_, index) => ({ role: "user", content: `request ${index}` })),
		);
		expect(visits).toBeLessThanOrEqual(entries.length * 2);
	});
});
