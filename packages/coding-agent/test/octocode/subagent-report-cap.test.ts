import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { tmp } from "./helpers.ts";

/**
 * What a child's report costs the parent: every later request sends the inline part again, so it is capped at 4 KB and
 * the whole report is linked, while the outcome still comes from the whole text.
 */

const INLINE_BYTES = 4 * 1024;
/** The trim notice `headPreview` appends to a cut preview. */
const NOTICE_BYTES = 120;

describe("the report a parent's context gets", () => {
	it("inlines at most 4 KB of a longer report and links the whole one, saved in the scratch folder", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		const whole = `done. Fixed the parser.\n${"evidence: src/parse.ts:12 checked\n".repeat(180)}Noticed: none`;
		expect(Buffer.byteLength(whole)).toBeGreaterThan(INLINE_BYTES + 1024);
		report.answer(whole, "stop");
		const result = report.result();
		expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(INLINE_BYTES + NOTICE_BYTES);
		expect(result.body.startsWith("done. Fixed the parser.")).toBe(true);
		expect(result.pointer).toMatch(/^Full report: .*report-[0-9a-f]{64}\.md/);
		expect(result.text).toBe(`${result.body}\n${result.pointer}`);
		expect(result).toMatchObject({ outcome: "done", answered: true });
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(whole);
	});

	it("inlines a report within the cap whole, with no file and no pointer", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		const whole = `partial: two of three.\n${"x".repeat(INLINE_BYTES - 100)}`;
		report.answer(whole, "stop");
		const result = report.result();
		expect(result.text).toBe(whole);
		expect(result.pointer).toBeUndefined();
		expect(result.outcome).toBe("partial");
		expect(fs.existsSync(path.join(scratch, "report.md"))).toBe(false);
	});

	it("reads the outcome of a long failed follow-up from its whole text, keeping the inline part capped", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer(`blocked - ${"needs a decision on the schema. ".repeat(300)}\nAsk user: which schema?`, "stop");
		const result = report.result();
		expect(result.outcome).toBe("blocked");
		expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(INLINE_BYTES + NOTICE_BYTES);
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toContain("Ask user: which schema?");
	});
});
