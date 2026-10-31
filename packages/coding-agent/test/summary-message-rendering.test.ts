import type { Box } from "@octocodeai/octocode-tui";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { userMessagesSection } from "../src/octocode/compaction/checkpoint-text.ts";
import { transcriptNote } from "../src/octocode/compaction/summary.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function lines(component: Box, width: number): string[] {
	return component.render(width).map((line) => stripAnsi(line).trimEnd());
}

const archiveLine =
	"Folder /var/octocode/agent/sessions/abc/archive (LIBRARY.md indexes every segment). This compaction is segment 3: `3-*.md`.";

/** A summary as Octocode writes it: the model's part, the kept user messages, then the Recovery section. */
function octocodeSummary(): string {
	return [
		"## Goal\nImprove compaction rendering.\n\n## Progress\n- Read the renderer.",
		userMessagesSection(
			[],
			0,
			["please load the skill\nand then compact", "check the diff"],
			undefined,
			undefined,
			null,
		),
		transcriptNote("/var/octocode/sessions/s.jsonl", false, [
			"Search it with the archive tool (a query, then file and line to read a hit).",
			archiveLine,
		]),
	].join("");
}

const compaction = () =>
	new CompactionSummaryMessageComponent({
		role: "compactionSummary",
		summary: octocodeSummary(),
		tokensBefore: 84_000,
		timestamp: Date.now(),
	});

describe("summary messages", () => {
	beforeAll(() => initTheme("dark"));

	test.each([80, 40])(
		"a collapsed compaction names its tokens and where the full record is, at %i columns",
		(width) => {
			const out = lines(compaction(), width);
			// A narrow width wraps the text over lines: compare it as one run of words.
			const text = out.join(" ").replace(/\s+/g, " ");
			expect(text).toContain("[compaction] Compacted 84,000 tokens into a ~");
			expect(text).toContain("archive: segment 3");
			expect(text).not.toContain("transcript:");
			expect(text).toContain("to expand)");
			expect(text).not.toContain("Improve compaction rendering");
			expect(text).not.toContain("<user-message>");
			for (const line of compaction().render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		},
	);

	test("an expanded compaction shows the summary and the kept messages without the model's tags and instructions", () => {
		const component = compaction();
		component.setExpanded(true);
		const text = lines(component, 80).join("\n");
		expect(text).toContain("Improve compaction rendering");
		expect(text).toContain("Kept 2 user messages word for word:");
		expect(text).toContain("- please load the skill");
		expect(text).not.toContain("and then compact");
		expect(text).not.toContain("<user-message>");
		expect(text).not.toContain("## User Messages");
		expect(text).toContain("transcript: /var/octocode/sessions/s.jsonl");
		expect(text).not.toContain("Recovery");
		expect(text).not.toContain("Search it with the archive tool");
		expect(text).not.toContain("to expand)");
	});

	test("a summary another writer produced is shown whole, without invented record lines", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "Plain summary text",
			tokensBefore: 1234,
			timestamp: Date.now(),
		});
		const collapsed = lines(component, 80).join("\n");
		expect(collapsed).toContain("Compacted 1,234 tokens");
		expect(collapsed).not.toContain("archive:");
		component.setExpanded(true);
		expect(lines(component, 80).join("\n")).toContain("Plain summary text");
	});

	test("a branch summary has its title and the expand hint on one line", () => {
		const component = new BranchSummaryMessageComponent({
			role: "branchSummary",
			summary: "branch details",
			fromId: "entry-1",
			timestamp: Date.now(),
		});
		expect(lines(component, 80).filter(Boolean)).toEqual([
			expect.stringContaining("[branch] Summary of the branch you left ("),
		]);
	});

	test.each([80, 40])("a skill invocation names the skill, its size and file, at %i columns", (width) => {
		const component = new SkillInvocationMessageComponent({
			name: "demo-review",
			location: "/skills/demo-review/SKILL.md",
			content: "References are relative to /skills/demo-review.\n\n# Demo review\n\n1. Read the diff.",
			userMessage: undefined,
		});
		const collapsed = lines(component, width).join(" ");
		expect(collapsed).toContain("[skill] demo-review \u00b7 3 lines");
		expect(collapsed).toContain("/skills/demo-review/SKILL.md");
		expect(collapsed).not.toContain("Read the diff");
		component.setExpanded(true);
		const expanded = lines(component, width).join(" ");
		expect(expanded).toContain("Read the diff");
		expect(expanded).not.toContain("References are relative");
	});
});
