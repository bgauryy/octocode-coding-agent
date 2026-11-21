/**
 * A row the reader collapses tells the screen first (`keepScrollbackOnCollapse`), so rows that scrolled away stay in
 * scrollback instead of a clear and a replay of the transcript; a row that never expanded says nothing.
 */
import { Text, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { LongResponse, RESPONSE_FOLD_THRESHOLD } from "../src/modes/interactive/components/long-response.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme } from "../src/theme/theme.ts";

const screen = () => {
	const keepScrollbackOnCollapse = vi.fn();
	return { ui: { requestRender: () => {}, keepScrollbackOnCollapse } as unknown as TUI, keepScrollbackOnCollapse };
};
const longText = Array.from({ length: RESPONSE_FOLD_THRESHOLD + 20 }, (_, i) => `line ${i}`).join("\n");

/** Expand, collapse, collapse again: one announcement, for the real change only. */
function collapsesOnce(
	row: { setExpanded(expanded: boolean): void; render?(width: number): string[] },
	spy: () => void,
) {
	row.setExpanded(false);
	expect(spy).not.toHaveBeenCalled();
	row.setExpanded(true);
	row.render?.(80);
	expect(spy).not.toHaveBeenCalled();
	row.setExpanded(false);
	row.setExpanded(false);
	expect(spy).toHaveBeenCalledTimes(1);
}

describe("collapsing a row keeps scrollback", () => {
	beforeAll(() => initTheme("dark"));

	test("a bash command row", () => {
		const { ui, keepScrollbackOnCollapse } = screen();
		const row = new BashExecutionComponent("seq 500", ui);
		row.appendOutput(longText);
		row.setComplete(0, false);
		collapsesOnce(row, keepScrollbackOnCollapse);
	});

	test("a long response, and not one too short to fold", () => {
		const collapsing = vi.fn();
		const row = new LongResponse(new Text(longText, 0, 0), false, () => {}, false, collapsing);
		row.render(80);
		collapsesOnce(row, collapsing);
		const short = vi.fn();
		const small = new LongResponse(new Text("short", 0, 0), true, () => {}, false, short);
		small.render(80);
		small.setExpanded(false);
		expect(short).not.toHaveBeenCalled();
	});

	test("an assistant message's long response", () => {
		const keepScrollbackOnCollapse = vi.fn();
		const row = new AssistantMessageComponent(undefined, true, undefined, undefined, 1, [], {
			keepScrollbackOnCollapse,
		});
		row.updateMessage({
			role: "assistant",
			content: [{ type: "text", text: longText }],
			stopReason: "stop",
		} as Parameters<AssistantMessageComponent["updateMessage"]>[0]);
		row.render(80);
		collapsesOnce(row, keepScrollbackOnCollapse);
	});

	test("collapsible messages: skill, branch and compaction summaries", () => {
		const skill = screen();
		collapsesOnce(
			new SkillInvocationMessageComponent(
				{ name: "s", location: "/tmp/s.md", content: longText, userMessage: undefined },
				undefined,
				1,
				skill.ui,
			),
			skill.keepScrollbackOnCollapse,
		);
		const branch = screen();
		collapsesOnce(
			new BranchSummaryMessageComponent(
				{ role: "branchSummary", summary: longText, fromId: "a", timestamp: 0 } as never,
				undefined,
				1,
				branch.ui,
			),
			branch.keepScrollbackOnCollapse,
		);
		const compaction = screen();
		collapsesOnce(
			new CompactionSummaryMessageComponent(
				{ role: "compactionSummary", summary: longText, tokensBefore: 1000, timestamp: 0 } as never,
				undefined,
				1,
				compaction.ui,
			),
			compaction.keepScrollbackOnCollapse,
		);
	});
});
