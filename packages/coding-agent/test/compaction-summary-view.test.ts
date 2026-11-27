import { expect, it } from "vitest";
import { compactionSummaryText, keptLine, viewSummary } from "../src/core/compaction/summary-view.ts";
import { compactionSummaryDisplay } from "../src/core/messages.ts";
import { writtenSummary } from "./octocode/fixtures/compaction-summary.ts";

it("reads a written summary as its body, kept messages and record locations", () => {
	const view = viewSummary(writtenSummary());
	expect(view.body).toBe("## Goal\nFix the login bug\n\n## TL;DR\nDid the work.");
	expect(view.messages).toEqual(["fix the login bug\nit fails on Safari"]);
	expect(view.archive).toEqual({ folder: "/sessions/s/archive", segment: 3 });
});

it("shows a person the summary without the model's tags and Recovery instructions", () => {
	const text = compactionSummaryDisplay({ summary: writtenSummary(), tokensBefore: 123_456 });
	expect(text).toContain("**Compacted 123,456 tokens into a ~");
	expect(text).toContain("## Goal\nFix the login bug");
	expect(text).toContain("- archive: segment 3 \u00b7 /sessions/s/archive");
	expect(text).toContain("Kept 1 user message word for word:\n- fix the login bug");
	expect(text).not.toContain("it fails on Safari");
	expect(text).not.toContain("<user-message>");
	expect(text).not.toContain("## Recovery");
	expect(text).not.toContain("Search it with");
});

it("lists a kept askUser answer by its question and answer, not its bare label", () => {
	const one = keptLine('[askUser answer]\n"Which state gets which colour of the subagent light?" → Green working');
	expect(one).toMatch(/^\[askUser answer\] "Which state.*" → Green working$/);
	const two = keptLine('[askUser answer]\n"Keep v1?" → No\n"Ship now?" → Yes');
	expect(two).toBe('[askUser answer] "Keep v1?" → No (+1 more)');
	expect(keptLine("fix the login bug\nit fails on Safari")).toBe("fix the login bug");
});

it("keeps a summary written by anything else whole", () => {
	expect(compactionSummaryText("Plain notes.", 10)).toMatch(
		/^\*\*Compacted 10 tokens into a ~\d+-token summary\*\*\n\nPlain notes\.$/,
	);
});
