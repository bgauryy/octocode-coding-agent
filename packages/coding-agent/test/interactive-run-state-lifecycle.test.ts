import { Container, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { handleRunStateEvent } from "../src/modes/interactive/interactive-mode/run-state-events.ts";
import { bindStatusIndicator } from "../src/modes/interactive/state/bind-status.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

/** A fake host whose status indicator is mounted by the real status binder, as the mode's host does. */
function statusHost<T extends object>(fake: T, onEscape: () => void = vi.fn()) {
	const host = createFakeHost({
		defaultEditor: { onEscape, setWorkingStatusIndicator: vi.fn() },
		autoCompactionEscapeHandler: undefined as (() => void) | undefined,
		statusContainer: new Container(),
		editor: {},
		session: { thinkingLevel: "off" },
		activeStatusIndicator: undefined as StatusIndicator | undefined,
		options: { tuiMode: "fullscreen" },
		ui: { requestRender: vi.fn(), getClearOnShrink: () => false } as unknown as TUI,
		...fake,
	});
	const stop = bindStatusIndicator(host);
	const line = () => stripAnsi(host.activeStatusIndicator?.render(200)[1] ?? "");
	const dispose = () => {
		host.uiStore.getState().clearStatusIndicator();
		stop();
	};
	return { host, line, dispose };
}

describe("interactive retry lifecycle", () => {
	beforeAll(() => initTheme("dark"));
	test("keeps Escape as the Stop key while a run waits to retry, across attempts", async () => {
		const originalEscape = vi.fn();
		const { host, dispose } = statusHost({ chatContainer: new Container(), showError: vi.fn() }, originalEscape);
		try {
			for (const attempt of [1, 2]) {
				await handleRunStateEvent(host, {
					type: "auto_retry_start",
					attempt,
					maxAttempts: 2,
					delayMs: 1000,
					errorMessage: "temporary failure",
				});
				expect(host.activeStatusIndicator?.kind).toBe("retry");
				// Escape during the wait reaches the editor's own handler: it stops the run and restores queued messages.
				expect(host.defaultEditor.onEscape).toBe(originalEscape);
			}
			await handleRunStateEvent(host, { type: "auto_retry_end", success: true, attempt: 2 });
			expect(host.defaultEditor.onEscape).toBe(originalEscape);
			expect(host.activeStatusIndicator).toBeUndefined();
		} finally {
			dispose();
		}
	});

	test("keeps compaction visible through a summary retry and restores Escape at the end", async () => {
		const originalEscape = vi.fn();
		const { host, dispose } = statusHost(
			{
				settingsManager: { getShowTerminalProgress: () => false },
				showError: vi.fn(),
				showStatus: vi.fn(),
				flushCompactionQueue: vi.fn(),
			},
			originalEscape,
		);
		try {
			await handleRunStateEvent(host, { type: "compaction_start", reason: "manual" });
			expect(host.activeStatusIndicator?.kind).toBe("compaction");
			await handleRunStateEvent(host, {
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 1000,
				errorMessage: "temporary failure",
			});
			expect(host.activeStatusIndicator?.kind).toBe("retry");
			await handleRunStateEvent(host, {
				type: "summarization_retry_attempt_start",
				source: "compaction",
				reason: "manual",
			});
			expect(host.activeStatusIndicator?.kind).toBe("compaction");
			await handleRunStateEvent(host, { type: "summarization_retry_finished" });
			expect(host.activeStatusIndicator?.kind).toBe("compaction");
			await handleRunStateEvent(host, {
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: true,
				willRetry: false,
			});
			expect(host.activeStatusIndicator).toBeUndefined();
			expect(host.defaultEditor.onEscape).toBe(originalEscape);
			// A cancelled manual compaction is a status, not an error.
			expect(host.showStatus).toHaveBeenCalledWith("Compaction cancelled");
			expect(host.showError).not.toHaveBeenCalledWith("Compaction cancelled");
		} finally {
			dispose();
		}
	});

	test("shows the summary's elapsed time and received size on the compaction line, never on a retry countdown", async () => {
		const { host, line, dispose } = statusHost({
			settingsManager: { getShowTerminalProgress: () => false },
			showError: vi.fn(),
		});
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
			dispose();
		}
	});

	test("an outage is one updating row with a countdown and adds nothing to the transcript per attempt", async () => {
		const { host, line, dispose } = statusHost({ chatContainer: new Container(), showError: vi.fn() });
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
			expect(line()).toContain("✗ ◆ Retry failed after 4 attempts: fetch failed (ENOTFOUND) - trying again in 60s");
			expect(line()).toMatch(/cancel\s*$/);
			expect(host.showError).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});
});
