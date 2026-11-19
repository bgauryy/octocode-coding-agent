import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keepPaidSummary, paidSummaryOf, type PaidSummary } from "../../src/octocode/compaction/paid-summary.ts";
import { tmp } from "./helpers.ts";

const session = (sessionFile: string | undefined) => ({ getSessionFile: () => sessionFile });
const paid: PaidSummary = {
	key: "k1",
	result: { summary: "the paid text", firstKeptEntryId: "e5", tokensBefore: 1234 },
	method: { method: "standalone", reason: "test" },
};

describe("a paid compaction summary across a resume", () => {
	it("is found again by the resumed session's manager", () => {
		const file = path.join(tmp("octocode-paid-"), "s.jsonl");
		keepPaidSummary(session(file), paid);
		expect(paidSummaryOf(session(file))).toEqual(paid);
	});

	it("is kept in memory for a session without a file", () => {
		const manager = session(undefined);
		keepPaidSummary(manager, paid);
		expect(paidSummaryOf(manager)).toEqual(paid);
		expect(paidSummaryOf(session(undefined))).toBeUndefined();
	});

	it("is absent for a session that paid nothing, or whose saved copy was cut short", () => {
		const file = path.join(tmp("octocode-paid-"), "s.jsonl");
		expect(paidSummaryOf(session(file))).toBeUndefined();
		fs.writeFileSync(`${file}.paid-summary.json`, '{"key":"k1","res');
		expect(paidSummaryOf(session(file))).toBeUndefined();
	});

	it("keeps only the latest paid summary", () => {
		const file = path.join(tmp("octocode-paid-"), "s.jsonl");
		keepPaidSummary(session(file), paid);
		keepPaidSummary(session(file), { ...paid, key: "k2" });
		expect(paidSummaryOf(session(file))?.key).toBe("k2");
	});
});
