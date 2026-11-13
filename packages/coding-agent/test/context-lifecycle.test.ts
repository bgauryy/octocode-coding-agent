import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { Markdown, visibleWidth } from "@octocodeai/octocode-tui";
import { expect, it, vi } from "vitest";
import { renderContextLifecycle, type ContextLifecycle } from "../src/core/agent-session/context-lifecycle.ts";
import { renderContextReport } from "../src/core/agent-session/context-report.ts";
import { getMarkdownTheme, initTheme } from "../src/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

it("distinguishes many recorded compactions from the one active checkpoint without changing model context", async () => {
	const harness = await createHarness({ compactionPolicy: { keepRecentTokens: 1234 } });
	try {
		const { sessionManager, session } = harness;
		for (let index = 0; index < 40; index++) {
			const kept = sessionManager.appendMessage({ role: "user", content: `Request ${index}`, timestamp: index });
			sessionManager.appendMessage(fauxAssistantMessage(`Evidence ${index}`));
			sessionManager.appendCompaction(`Private checkpoint ${index}`, kept, 4000 + index);
		}
		session.refreshContext();
		const before = sessionManager.buildSessionProjection();
		const entries = sessionManager.getEntries();
		const request = vi.spyOn(session.agent, "streamFunction");
		const report = session.getContextReport();
		expect(report.compaction).toMatchObject({
			recordedCompactions: 40,
			activeCheckpoints: 1,
			otherMessages: 2,
			keepRecentTokens: 1234,
			persistent: false,
			latest: { tokensBefore: 4039, separateCheckpoint: false },
		});
		const text = renderContextReport(report);
		expect(text).toContain("40 recorded compactions on this branch · 1 active checkpoint");
		expect(text).not.toContain("Private checkpoint");
		expect(text).toContain("target: 1,234 tokens");
		expect(text).toContain("This session is not saved to a file");
		expect(sessionManager.getEntries()).toEqual(entries);
		expect(sessionManager.buildSessionProjection()).toEqual(before);
		expect(request).not.toHaveBeenCalled();
	} finally {
		harness.cleanup();
	}
});

it("shows manual compaction without promising an automatic trigger when disabled", async () => {
	const harness = await createHarness({ compactionPolicy: { enabled: false } });
	try {
		const text = renderContextReport(harness.session.getContextReport());
		expect(text).toContain("Automatic compaction is off. /compact runs it manually.");
		expect(text).not.toContain("Automatic compaction is eligible above");
		expect(text).toContain("No checkpoint on this branch yet.");
	} finally {
		harness.cleanup();
	}
});

it("separates summary, replacement, continuation, cache, saved notes and searchable history", () => {
	const state: ContextLifecycle = {
		enabled: true,
		recordedCompactions: 3,
		activeCheckpoints: 1,
		otherMessages: 4,
		keepRecentTokens: 20_000,
		persistent: true,
		latest: { at: "2026-11-13T00:00:00.000Z", tokensBefore: 180_000, separateCheckpoint: true },
	};
	const text = renderContextLifecycle(state, 175_000);
	for (const stage of ["Trigger", "Summarize", "Compact", "Continue"]) expect(text).toContain(`| ${stage} |`);
	for (const layer of ["Working context", "Saved memory", "History", "Prompt cache"])
		expect(text).toContain(`| ${layer} |`);
	expect(text).toContain("Automatic above 175,000 tokens when history is eligible");
	expect(text).toContain("Save the checkpoint and original transcript");
	expect(text).toContain("full checkpoint saved separately");
	expect(text).toContain("compaction does not automatically save a memory note");
	expect(text).toContain("/archive browses compacted segments");
	expect(text).toContain("search earlier conversations with the archive tool");
	expect(text).not.toContain("/archive search");
	expect(text).toContain("cached input still occupies context");
	expect(text).toContain("compaction changes the history after that prefix");
});

it.each([40, 80, 120])("renders the lifecycle through the terminal Markdown component at %s columns", (width) => {
	initTheme();
	const text = renderContextLifecycle(
		{
			enabled: true,
			recordedCompactions: 40,
			activeCheckpoints: 1,
			otherMessages: 2,
			keepRecentTokens: 20_000,
			persistent: true,
			latest: null,
		},
		175_000,
	);
	const lines = new Markdown(text, 1, 1, getMarkdownTheme()).render(width);
	expect(lines.length).toBeGreaterThan(10);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});
