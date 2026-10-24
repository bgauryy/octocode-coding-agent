import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REPORT_MAX_BYTES } from "../../src/octocode/instructions/report.ts";
import { capOutput } from "../../src/octocode/shared/util.ts";
import { ReportTracker, reportOutcome, reportStatus } from "../../src/octocode/subagents/report.ts";
import { tmp } from "./helpers.ts";

describe("the outcome word a report starts with", () => {
	it.each([
		["done", "done"],
		["Done. Fixed the bug.", "done"],
		["**Partial**: two of three", "partial"],
		["  \n blocked - needs a decision", "blocked"],
		["FAILED: tests red", "failed"],
		["`done`", "done"],
		["**Report: partial.** two of three", "partial"],
		["Status: done", "done"],
		["**Outcome:** blocked", "blocked"],
		["**Report**: Failed - tests red", "failed"],
		["report:\ndone", "done"],
		["  Outcome : DONE.", "done"],
		["Done with the audit and the fixes", "done"],
		["Done. Fixed the failing test", "done"],
	])("reads %j as %s", (text, status) => expect(reportStatus(text)).toBe(status));

	it.each([
		[undefined],
		[""],
		["Finished the work"],
		["Not done yet"],
		["doneness"],
		["done-ish"],
		["The task is done"],
		["1. done"],
		["Report: not done yet"],
		["Status: the task is done"],
		["Report"],
		["Report: 1. done"],
		["Summary: done"],
		["Report: Status: done"],
		["Reporting: done"],
		["Done with the audit, but blocked by the missing fixture"],
		["Partial progress, tests failed"],
	])("treats %j as unknown, never a failure", (text) => expect(reportStatus(text)).toBeUndefined());
});

describe("a trailing outcome line", () => {
	it.each([
		["Fixed the parser.\n\noutcome: done", "done"],
		["Two of three.\n**Outcome:** partial.\n\n", "partial"],
		["Needs a decision\nStatus: BLOCKED", "blocked"],
		["Tests red.\nReport: failed", "failed"],
	])("reads %j from its last line", (text, status) => {
		expect(reportOutcome(text)).toEqual({ status, source: "last" });
		expect(reportStatus(text)).toBe(status);
	});

	it("prefers the first word when both are present", () => {
		expect(reportOutcome("partial: two of three\n\noutcome: done")).toEqual({ status: "partial", source: "first" });
		expect(reportOutcome("done")).toEqual({ status: "done", source: "first" });
	});

	it.each([
		["Fixed it.\nthe outcome was done earlier"],
		["Fixed it.\ndone"],
		["Fixed it.\noutcome: not done yet"],
		["Fixed it.\noutcome: done\nThen more prose."],
		["Fixed it.\nSummary: done"],
	])("treats %j as unknown", (text) => expect(reportOutcome(text)).toBeUndefined());

	it("reaches the tracker's result with its source", () => {
		const report = new ReportTracker();
		report.answer("All fixed and verified.\n\noutcome: done", "stop");
		expect(report.result()).toMatchObject({ outcome: "done", outcomeSource: "last" });
	});
});

describe("a failed reply's error message", () => {
	it("reaches the parent whole, however long the provider's message is", () => {
		const message = `provider said: ${"overloaded, retry later; ".repeat(80)}the end`;
		const report = new ReportTracker();
		report.answer("partial findings", "error", message);
		expect(report.result().error).toBe(message);
		expect(report.result().error).not.toContain("more characters cut");
	});
});

describe("incremental subagent reports", () => {
	it("uses the latest outcome independently of the chronological preview", () => {
		const report = new ReportTracker();
		report.answer("done: first task", "stop");
		report.incoming("custom");
		report.answer("blocked: need a decision", "stop");
		expect(report.result()).toMatchObject({ outcome: "blocked", answered: true });
		expect(report.result().text).toContain("done: first task");
		report.incoming("custom");
		report.answer("No outcome word this time", "stop");
		expect(report.result().outcome).toBeUndefined();
	});

	it("propagates a failed follow-up without discarding the earlier report, and clears it on recovery", () => {
		const report = new ReportTracker();
		report.answer("done: first task", "stop");
		report.incoming("custom");
		report.answer("", "error", "provider failed");
		expect(report.result()).toMatchObject({ error: "provider failed", answered: true });
		expect(report.result().text).toContain("done: first task");
		report.answer("partial: recovered", "stop");
		expect(report.result()).toMatchObject({ outcome: "partial" });
		expect(report.result().error).toBeUndefined();
	});
	it("does not reuse a completed outcome for an empty final follow-up", () => {
		const report = new ReportTracker();
		report.answer("done: first task", "stop");
		report.incoming("custom");
		report.answer(undefined, "stop");
		expect(report.result().error).toMatch(/follow-up.*without a final answer/i);
		expect(report.result().text).toContain("done: first task");
		report.answer("partial: new task needs more work", "stop");
		expect(report.result()).toMatchObject({ outcome: "partial" });
		expect(report.result().error).toBeUndefined();
	});
	it("marks output-limit answers incomplete and accepts a later successful retry", () => {
		const report = new ReportTracker(tmp());
		report.answer("The analysis is unfinished", "length");
		expect(report.result()).toEqual({
			text: "The analysis is unfinished",
			body: "The analysis is unfinished",
			answered: false,
			error: "Model output limit reached; the report is incomplete",
		});
		report.answer("Verified complete report", "stop");
		expect(report.result()).toEqual({
			text: "Verified complete report",
			body: "Verified complete report",
			answered: true,
		});
	});

	it.each([
		["multibyte bytes", "שלום😀".repeat(2000)],
		["lines", "line\n".repeat(300)],
		["exact byte boundary", "x".repeat(REPORT_MAX_BYTES)],
		["empty first line", `\n${"x".repeat(9000)}`],
	])("keeps the exact whole-report preview across %s overflow and retries", (_name, first) => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		const sections = [first];
		report.answer(first, "stop");
		for (let i = 0; i < 5; i++) {
			report.incoming("custom");
			report.answer("superseded ".repeat(1000), "stop");
			const next = `follow-up ${i}\nmore evidence`;
			report.answer(next, "stop");
			sections.push(next);
			const whole = sections.join("\n\n---\n\n");
			expect(report.result().text.split("\nFull report:")[0]).toBe(capOutput(whole, REPORT_MAX_BYTES, 200));
			expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(whole);
		}
	});

	it("preserves a large partial answer when a child fails before completing a report", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		const partial = "partial detail ".repeat(2000);
		report.answer(partial, "error", "provider failed");
		expect(report.result()).toMatchObject({ answered: false, error: "provider failed" });
		expect(report.result().text).toContain("Full partial report:");
		// The pointer is its own field, so a caller that shortens the body keeps it.
		const { text, body, pointer } = report.result();
		expect(pointer).toMatch(/^Full partial report: .*partial-report\.md/);
		expect(text).toBe(`${body}\n${pointer}`);
		expect(Buffer.byteLength(report.result().text)).toBeLessThan(10 * 1024);
		expect(fs.readFileSync(path.join(scratch, "partial-report.md"), "utf8")).toBe(partial);
	});

	it("preserves all follow-ups on disk with a bounded preview", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		const sections = Array.from({ length: 100 }, (_, i) => `Section ${i}: ${"detail ".repeat(2000)}`);
		for (const section of sections) {
			report.incoming("custom");
			report.answer(section, "stop");
			expect(Buffer.byteLength(report.result().text)).toBeLessThan(10 * 1024);
		}
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(sections.join("\n\n---\n\n"));
		// One preview of the whole report and one pointer, not a truncation notice per follow-up.
		const text = report.result().text;
		expect(text.match(/\[Output trimmed/g)).toHaveLength(1);
		expect(text.match(/Full report:/g)).toHaveLength(1);
		expect(text.startsWith("Section 0: ")).toBe(true);
	});

	it("previews the whole report after short follow-ups, counting every line, with one notice and one pointer", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		report.answer("line of text\n".repeat(1000), "stop");
		for (let i = 0; i < 3; i++) {
			report.incoming("custom");
			report.answer(`follow-up ${i}`, "stop");
		}
		const whole = fs.readFileSync(path.join(scratch, "report.md"), "utf8");
		const text = report.result().text;
		expect(text).toContain(`of ${whole.split("\n").length} lines`);
		expect(text.match(/\[Output trimmed/g)).toHaveLength(1);
		expect(text.match(/Full report:/g)).toHaveLength(1);
	});

	it("replaces a retry at its UTF-8 byte offset without keeping the superseded answer", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		const first = "שלום ".repeat(2000);
		report.answer(first, "stop");
		report.incoming("custom");
		report.answer("obsolete ".repeat(2000), "stop");
		report.answer("replacement", "stop");
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(`${first}\n\n---\n\nreplacement`);
		report.incoming("custom");
		report.answer("replacement", "stop");
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(`${first}\n\n---\n\nreplacement`);
	});

	it("keeps a bounded answer when scratch is unavailable and shows controls in the disk report as visible escapes", () => {
		const scratch = tmp();
		const text = `\u001b[2J${"detail ".repeat(2000)}\u202e`;
		const disk = new ReportTracker(scratch);
		disk.answer(text, "stop");
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(
			`\\u{1b}[2J${"detail ".repeat(2000)}\\u{202e}`,
		);
		const unavailable = new ReportTracker(path.join(scratch, "missing"));
		unavailable.answer(text, "stop");
		expect(unavailable.result().text).not.toContain("Full report:");
		expect(Buffer.byteLength(unavailable.result().text)).toBeLessThan(9 * 1024);
	});

	it("keeps the prior report and a bounded preview when a later disk append fails", () => {
		const scratch = tmp();
		const report = new ReportTracker(scratch);
		const first = "verified evidence\n".repeat(1000);
		report.answer(first, "stop");
		const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		try {
			report.incoming("custom");
			report.answer("later evidence", "stop");
			expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(first);
			expect(report.result().text).toBe(capOutput(`${first}\n\n---\n\nlater evidence`, REPORT_MAX_BYTES, 200));
			expect(report.result().text).not.toContain("Full report:");
		} finally {
			append.mockRestore();
		}
	});
});
