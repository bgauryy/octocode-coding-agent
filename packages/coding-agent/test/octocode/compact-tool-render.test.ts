import { describe, expect, it, vi } from "vitest";
import { COMPACT_TOOL, CompactRequests, registerCompactTool } from "../../src/octocode/compaction/compact-tool.ts";
import { ThrashBreaker } from "../../src/octocode/compaction/pacing.ts";
import { fakeHost, rendered, theme } from "./fake-host.ts";

const context = (overrides: Record<string, unknown> = {}) => ({
	state: {},
	invalidate: vi.fn(),
	executionStarted: true,
	isPartial: false,
	isError: false,
	expanded: false,
	args: {},
	...overrides,
});

function tool() {
	const fake = fakeHost();
	registerCompactTool(fake.api, new CompactRequests(new ThrashBreaker()), false);
	return fake.tools.get(COMPACT_TOOL)!;
}

const text = (value: string, details?: unknown) => ({ content: [{ type: "text", text: value }], details });

describe("compact tool row", () => {
	it("draws the call as `Compact(<focus>)`, not as raw arguments", () => {
		const row = rendered(
			tool().renderCall({ focus: "keep the audit findings", reason: "task boundary" }, theme, context()),
		);
		expect(row).toContain("Compact(keep the audit findings)");
		expect(row).not.toContain("focus=");
		expect(rendered(tool().renderCall({}, theme, context()))).toMatch(/Compact(?!\()/);
	});

	it("says what happens next instead of the model's instruction", () => {
		const result = text("Compaction queued: ... End your reply now with a one-line status.", { queued: true });
		const collapsed = rendered(tool().renderResult(result, { expanded: false }, theme, context()), 100);
		expect(collapsed).toContain("Queued \u00b7 runs when this reply ends");
		expect(collapsed).not.toContain("End your reply");
		const again = text("Compaction is already queued ...", { queued: true, already: true });
		expect(rendered(tool().renderResult(again, { expanded: false }, theme, context()), 100)).toContain(
			"Already queued",
		);
	});

	it("draws a refusal as not run, with its reason and no model advice or `Error:` prefix", () => {
		const refusal = text("Compaction refused: the context was compacted one turn ago. Continue the task.");
		const ctx = context({ isError: true });
		const row = rendered(tool().renderResult(refusal, { expanded: false }, theme, ctx), 120);
		expect(row).toContain("Compaction refused: the context was compacted one turn ago.");
		expect(row).not.toContain("Continue the task");
		expect(row).not.toContain("Error:");
		// The header reads the stopped state the result recorded: `\u25fc`, not the failure mark.
		expect(rendered(tool().renderCall({}, theme, ctx))).toContain("\u25fc");
	});

	it("wraps a long refusal at a narrow width instead of cutting it", () => {
		const long = text(
			"Compaction refused: the context is 12% of the room before automatic compaction, under 50%, so a summary would free little. Continue the task.",
		);
		const lines = tool()
			.renderResult(long, { expanded: false }, theme, context({ isError: true }))
			.render(40) as string[];
		expect(lines.length).toBeGreaterThan(2);
		expect(lines.join(" ")).toContain("would free little");
	});
});
