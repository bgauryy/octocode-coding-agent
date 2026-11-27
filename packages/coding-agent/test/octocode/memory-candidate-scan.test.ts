import { describe, expect, it } from "vitest";
import { CANDIDATE_SCAN, listCandidates } from "../../src/octocode/memory/file/candidates.ts";
import { CANDIDATE_TAG } from "../../src/octocode/memory/file/candidate-tags.ts";
import type { Memory } from "../../src/octocode/memory/record.ts";

const note = (id: number, keywords: string) => ({ id, keywords }) as unknown as Memory;

describe("listCandidates scan bound", () => {
	it("reads at most CANDIDATE_SCAN notes and keeps only candidates among them", () => {
		let asked: number | undefined;
		const rows = [note(1, "plain"), note(2, CANDIDATE_TAG)];
		const found = listCandidates({
			list: (_scope, limit) => {
				asked = limit;
				return rows;
			},
		});
		expect(asked).toBe(CANDIDATE_SCAN);
		expect(found.map((memory) => memory.id)).toEqual([2]);
	});
});
