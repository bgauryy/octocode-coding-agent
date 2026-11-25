import { Container, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { bindStatusIndicator } from "../src/modes/interactive/state/bind-status.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function setup() {
	const requestRender = vi.fn();
	const host = createFakeHost({
		uiStore: createUiStore(),
		ui: { requestRender, getClearOnShrink: () => false } as unknown as TUI,
		statusContainer: new Container(),
		editor: {},
		defaultEditor: { setWorkingStatusIndicator: vi.fn() },
		session: { thinkingLevel: "off" },
		activeStatusIndicator: undefined as StatusIndicator | undefined,
		options: { tuiMode: "fullscreen" },
	});
	const stop = bindStatusIndicator(host);
	const row = () => stripAnsi(host.statusContainer.render(160).join("\n"));
	const frames = () => requestRender.mock.calls.length;
	return { host, store: host.uiStore.getState(), stop, row, frames };
}

describe("status indicator in the status slice", () => {
	beforeAll(() => initTheme("dark"));
	let current: ReturnType<typeof setup> | undefined;
	afterEach(() => {
		current?.store.clearStatusIndicator();
		current?.stop();
		current = undefined;
	});

	it("working: mounts the indicator with the feature's message and follows message and model-wait changes", () => {
		current = setup();
		const { host, store, row } = current;
		store.setWorkingMessage("Indexing files");
		store.showStatusIndicator({ kind: "working" });
		expect(host.activeStatusIndicator?.kind).toBe("working");
		expect(row()).toContain("Indexing files");

		store.setWorkingWait("Waiting for the model");
		expect(row()).toContain("Waiting for the model");
		store.setWorkingWait(undefined);
		expect(row()).toContain("Indexing files");

		store.setWorkingMessage(undefined);
		expect(row()).toContain("Working");
		expect(row()).not.toContain("Indexing files");
	});

	it("compaction: progress updates the mounted row; progress for another kind changes nothing", () => {
		current = setup();
		const { store, row, frames } = current;
		store.showStatusIndicator({ kind: "compaction", reason: "manual" });
		expect(row()).toContain("Compacting context…");
		store.setCompactionProgress({ elapsedMs: 65_000, receivedChars: 12_800 });
		expect(row()).toMatch(/1m0?5s/);
		expect(row()).toContain("tokens received");

		store.showStatusIndicator({ kind: "retry", attempt: 1, maxAttempts: 3, delayMs: 2_000 });
		const before = { frames: frames(), row: row() };
		store.setCompactionProgress({ elapsedMs: 70_000, receivedChars: 20_000 });
		expect(frames()).toBe(before.frames);
		expect(row()).toBe(before.row);
	});

	it("retry: shows the attempt and countdown, and a new attempt remounts with its own countdown", () => {
		current = setup();
		const { host, store, row } = current;
		store.showStatusIndicator({ kind: "retry", attempt: 1, maxAttempts: 3, delayMs: 5_000 });
		expect(row()).toContain("Retrying (1/3) in 5s");
		const first = host.activeStatusIndicator;
		store.showStatusIndicator({ kind: "retry", attempt: 2, maxAttempts: 3, delayMs: 9_000 });
		expect(host.activeStatusIndicator).not.toBe(first);
		expect(row()).toContain("Retrying (2/3) in 9s");

		store.showStatusIndicator({ kind: "retry", attempt: 3, maxAttempts: 3, delayMs: 4_000, offline: "fetch failed" });
		expect(row()).toContain("fetch failed");
	});

	it("clearing another kind is a no-op; clearing the shown kind empties the row with one frame", () => {
		current = setup();
		const { host, store, row, frames } = current;
		store.showStatusIndicator({ kind: "working" });
		const shown = { frames: frames(), row: row() };
		store.clearStatusIndicator("retry");
		expect(frames()).toBe(shown.frames);
		expect(row()).toBe(shown.row);
		expect(host.activeStatusIndicator?.kind).toBe("working");

		store.clearStatusIndicator("working");
		expect(host.activeStatusIndicator).toBeUndefined();
		expect(row()).toBe("");
		expect(frames()).toBe(shown.frames + 1);
		store.clearStatusIndicator();
		expect(frames()).toBe(shown.frames + 1);
	});

	it("stops following the store when stopped", () => {
		current = setup();
		const { host, store, stop } = current;
		stop();
		store.showStatusIndicator({ kind: "branchSummary" });
		expect(host.activeStatusIndicator).toBeUndefined();
	});
});
