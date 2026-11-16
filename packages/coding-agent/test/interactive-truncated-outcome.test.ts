import { describe, expect, it, vi } from "vitest";
import { handleRunStateEvent } from "../src/modes/interactive/interactive-mode/run-state-events.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function fakeHost() {
	return createFakeHost({
		session: { isStreaming: false },
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		clearStatusIndicator: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		showError: vi.fn(),
		showWarning: vi.fn(),
	});
}

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("interactive run outcome", () => {
	it("shows why the session ended a truncated run", async () => {
		const host = fakeHost();
		await handleRunStateEvent(host, {
			type: "agent_settled",
			aborted: false,
			outcome: { status: "truncated", stopReason: "length", errorMessage: "Run stopped: cut off", usage: usage() },
		} as never);
		expect(host.showError).toHaveBeenCalledWith("Run stopped: cut off");
	});

	it("adds nothing for a plain truncation the message already reports", async () => {
		const host = fakeHost();
		await handleRunStateEvent(host, {
			type: "agent_settled",
			aborted: false,
			outcome: { status: "truncated", stopReason: "length", usage: usage() },
		} as never);
		expect(host.showError).not.toHaveBeenCalled();
	});

	it("shows a run warning once, on any status", async () => {
		const host = fakeHost();
		const event = {
			type: "agent_settled",
			aborted: false,
			outcome: { status: "completed", warning: "continuing on fallback", usage: usage() },
		} as never;
		await handleRunStateEvent(host, event);
		expect(host.showWarning).toHaveBeenCalledTimes(1);
		expect(host.showWarning).toHaveBeenCalledWith("continuing on fallback");
		expect(host.showError).not.toHaveBeenCalled();
	});

	it("does not repeat the warning when it equals the error shown", async () => {
		const host = fakeHost();
		await handleRunStateEvent(host, {
			type: "agent_settled",
			aborted: false,
			outcome: { status: "truncated", errorMessage: "same", warning: "same", usage: usage() },
		} as never);
		expect(host.showError).toHaveBeenCalledTimes(1);
		expect(host.showWarning).not.toHaveBeenCalled();
	});
});
