import { beforeAll, describe, expect, test, vi } from "vitest";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { handleRunStateEvent } from "../src/modes/interactive/interactive-mode/run-state-events.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

describe("interactive retry lifecycle", () => {
	beforeAll(() => initTheme("dark"));
	test("restores the original Escape handler after multiple retry attempts", async () => {
		const originalEscape = vi.fn();
		let active: StatusIndicator | undefined;
		const host = createFakeHost({
			defaultEditor: { onEscape: originalEscape },
			retryEscapeHandler: undefined as (() => void) | undefined,
			ui: { requestRender: vi.fn() },
			showStatusIndicator(indicator: StatusIndicator) {
				active?.dispose();
				active = indicator;
			},
			clearStatusIndicator(kind: StatusIndicator["kind"]) {
				if (active?.kind !== kind) return;
				active.dispose();
				active = undefined;
			},
			showError: vi.fn(),
		});
		try {
			for (const attempt of [1, 2]) {
				await handleRunStateEvent(host, {
					type: "auto_retry_start",
					attempt,
					maxAttempts: 2,
					delayMs: 1000,
					errorMessage: "temporary failure",
				});
				expect(active?.kind).toBe("retry");
				expect(host.defaultEditor.onEscape).not.toBe(originalEscape);
			}
			await handleRunStateEvent(host, { type: "auto_retry_end", success: true, attempt: 2 });
			expect(host.defaultEditor.onEscape).toBe(originalEscape);
			expect(host.retryEscapeHandler).toBeUndefined();
			expect(active).toBeUndefined();
		} finally {
			active?.dispose();
		}
	});

	test("keeps compaction visible through a summary retry and restores Escape at the end", async () => {
		const originalEscape = vi.fn();
		let active: StatusIndicator | undefined;
		const host = createFakeHost({
			defaultEditor: { onEscape: originalEscape },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			editor: {},
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn() },
			showStatusIndicator(indicator: StatusIndicator) {
				active?.dispose();
				active = indicator;
			},
			clearStatusIndicator(kind: StatusIndicator["kind"]) {
				if (active?.kind !== kind) return;
				active.dispose();
				active = undefined;
			},
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn(),
		});
		try {
			await handleRunStateEvent(host, { type: "compaction_start", reason: "manual" });
			expect(active?.kind).toBe("compaction");
			await handleRunStateEvent(host, {
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 1000,
				errorMessage: "temporary failure",
			});
			expect(active?.kind).toBe("retry");
			await handleRunStateEvent(host, {
				type: "summarization_retry_attempt_start",
				source: "compaction",
				reason: "manual",
			});
			expect(active?.kind).toBe("compaction");
			await handleRunStateEvent(host, { type: "summarization_retry_finished" });
			expect(active?.kind).toBe("compaction");
			await handleRunStateEvent(host, {
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: true,
				willRetry: false,
			});
			expect(active).toBeUndefined();
			expect(host.defaultEditor.onEscape).toBe(originalEscape);
			// A cancelled manual compaction is a status, not an error.
			expect(host.showStatus).toHaveBeenCalledWith("Compaction cancelled");
			expect(host.showError).not.toHaveBeenCalledWith("Compaction cancelled");
		} finally {
			active?.dispose();
		}
	});

	test("shows the summary's elapsed time and received size on the compaction line, never on a retry countdown", async () => {
		const host = createFakeHost({
			defaultEditor: { onEscape: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			activeStatusIndicator: undefined as StatusIndicator | undefined,
			editor: {},
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn() },
			showStatusIndicator(indicator: StatusIndicator) {
				host.activeStatusIndicator?.dispose();
				host.activeStatusIndicator = indicator;
			},
			showError: vi.fn(),
		});
		const line = () => stripAnsi(host.activeStatusIndicator?.render(200)[1] ?? "");
		try {
			await handleRunStateEvent(host, { type: "compaction_start", reason: "threshold" });
			expect(line()).toContain("Auto-compacting… · ");
			expect(line()).not.toContain("tokens received");
			await handleRunStateEvent(host, {
				type: "compaction_progress",
				reason: "threshold",
				elapsedMs: 65_000,
				receivedChars: 9_600,
			});
			expect(line()).toContain("Auto-compacting… 1m05s · ~3.8k tokens received · ");
			await handleRunStateEvent(host, {
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 1000,
				errorMessage: "timed out",
			});
			await handleRunStateEvent(host, {
				type: "compaction_progress",
				reason: "threshold",
				elapsedMs: 66_000,
				receivedChars: 9_600,
			});
			expect(host.activeStatusIndicator?.kind).toBe("retry");
			expect(line()).not.toContain("tokens received");
		} finally {
			host.activeStatusIndicator?.dispose();
		}
	});

	test("an outage is one updating row with a countdown and adds nothing to the transcript per attempt", async () => {
		const host = createFakeHost({
			defaultEditor: { onEscape: vi.fn() },
			retryEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			activeStatusIndicator: undefined as StatusIndicator | undefined,
			editor: {},
			ui: { requestRender: vi.fn() },
			showStatusIndicator(indicator: StatusIndicator) {
				host.activeStatusIndicator?.dispose();
				host.activeStatusIndicator = indicator;
			},
			clearStatusIndicator: vi.fn(),
			showError: vi.fn(),
		});
		const line = () => stripAnsi(host.activeStatusIndicator?.render(200)[1] ?? "");
		try {
			for (const attempt of [1, 2, 3]) {
				await handleRunStateEvent(host, {
					type: "auto_retry_start",
					attempt,
					maxAttempts: 0,
					delayMs: 60_000,
					errorMessage: "fetch failed (ENOTFOUND)",
					offlineSince: 1,
				});
			}
			await handleRunStateEvent(host, {
				type: "summarization_retry_scheduled",
				attempt: 4,
				maxAttempts: 0,
				delayMs: 60_000,
				errorMessage: "fetch failed (ENOTFOUND)",
				offlineSince: 1,
			});
			expect(line()).toContain("✗ 🦈 Retry failed after 4 attempts: fetch failed (ENOTFOUND) - trying again in 60s");
			expect(line()).toMatch(/cancel\s*$/);
			expect(host.showError).not.toHaveBeenCalled();
		} finally {
			host.activeStatusIndicator?.dispose();
		}
	});
});
