import { describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { shortPath } from "../../src/utils/display-path.ts";
import { reportDigest } from "../../src/octocode/subagents/report-digest.ts";

const file = "/tmp/report-x.md";
const pointer = renderPrompt("notices/subagents/report-pointer.md", { partial: false, file: shortPath(file) });

describe("reportDigest", () => {
	it("keeps a short report whole", () => {
		const text = `done\n${pointer}`;
		expect(reportDigest(text, file)).toBe(text);
	});
	it("cuts a long saved report to its head and keeps the pointer", () => {
		const text = `outcome line\n${"word ".repeat(2000)}\n${pointer}`;
		const digest = reportDigest(text, file);
		expect(digest.length).toBeLessThan(2_300);
		expect(digest.startsWith("outcome line")).toBe(true);
		expect(digest.endsWith(pointer)).toBe(true);
	});
	it("leaves a report without a saved file whole", () => {
		const text = "x".repeat(5000);
		expect(reportDigest(text, undefined)).toBe(text);
		expect(reportDigest(text, file)).toBe(text);
	});
});
