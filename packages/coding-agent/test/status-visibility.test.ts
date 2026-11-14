import { describe, expect, it, vi } from "vitest";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { setWorkingVisible } from "../src/modes/interactive/interactive-mode/status-indicators.ts";

function fixture(kind?: "working" | "retry" | "compaction" | "branchSummary", streaming = true) {
	const activeStatusIndicator = kind ? { kind, dispose: vi.fn() } : undefined;
	const host = {
		activeStatusIndicator,
		workingVisible: false,
		session: { isStreaming: streaming },
		showWorkingStatusIndicator: vi.fn(),
		clearStatusIndicator: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeHost;
	return host;
}

describe("working indicator visibility", () => {
	it.each(["retry", "compaction", "branchSummary", "working"] as const)(
		"preserves an active %s indicator when working activity is enabled",
		(kind) => {
			const host = fixture(kind);
			const active = host.activeStatusIndicator;
			setWorkingVisible(host, true);
			expect(host.workingVisible).toBe(true);
			expect(host.activeStatusIndicator).toBe(active);
			expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled();
			expect(active?.dispose).not.toHaveBeenCalled();
		},
	);

	it("restores working activity while streaming when no higher-priority activity is active", () => {
		const host = fixture();
		setWorkingVisible(host, true);
		expect(host.showWorkingStatusIndicator).toHaveBeenCalledOnce();
	});

	it("does not create activity in an idle session", () => {
		const host = fixture(undefined, false);
		setWorkingVisible(host, true);
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled();
	});

	it("hides only working activity", () => {
		const host = fixture("retry");
		setWorkingVisible(host, false);
		expect(host.clearStatusIndicator).toHaveBeenCalledWith("working");
	});
});
