import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleResumeSession } from "../src/modes/interactive/interactive-mode/session-navigation.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import type * as Liveness from "../src/octocode/shared/session-liveness.ts";

const { livePid } = vi.hoisted(() => ({ livePid: vi.fn() }));
vi.mock("../src/octocode/shared/session-liveness.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Liveness>()),
	sessionFileRunningPid: livePid,
}));

function context(currentFile = "/tmp/current.jsonl") {
	return {
		// After a switch, the resume notice (resume-notice.ts) names the session and counts its messages.
		sessionManager: {
			getSessionFile: () => currentFile,
			getEntries: () => [],
			getSessionName: () => undefined,
			getSessionId: () => "01a1other",
		},
		runtimeHost: { switchSession: vi.fn(async () => ({ cancelled: false })) },
		showExtensionConfirm: vi.fn(async () => true),
		clearStatusIndicator: vi.fn(),
		showStatus: vi.fn(),
	};
}

describe("interactive resume guards", () => {
	beforeEach(() => livePid.mockReset());

	it("does not tear down and recreate the current session", async () => {
		const ctx = context();
		const result = await handleResumeSession(createFakeHost(ctx), "/tmp/current.jsonl");
		expect(result).toEqual({ cancelled: true });
		expect(ctx.runtimeHost.switchSession).not.toHaveBeenCalled();
		expect(ctx.showExtensionConfirm).not.toHaveBeenCalled();
		expect(ctx.clearStatusIndicator).not.toHaveBeenCalled();
		expect(livePid).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("That is the current session.");
	});

	it("keeps the current runtime when a live-session resume is rejected", async () => {
		const ctx = context();
		livePid.mockReturnValue(42);
		ctx.showExtensionConfirm.mockResolvedValue(false);
		const result = await handleResumeSession(createFakeHost(ctx), "/tmp/other.jsonl");
		expect(result).toEqual({ cancelled: true });
		expect(ctx.runtimeHost.switchSession).not.toHaveBeenCalled();
		expect(ctx.showExtensionConfirm).toHaveBeenCalledWith("Session is running", expect.stringContaining("pid 42"));
	});

	it("switches after a live-session resume is accepted", async () => {
		const ctx = context();
		livePid.mockReturnValue(42);
		const result = await handleResumeSession(createFakeHost(ctx), "/tmp/other.jsonl");
		expect(result).toEqual({ cancelled: false });
		expect(ctx.runtimeHost.switchSession).toHaveBeenCalledWith("/tmp/other.jsonl", expect.any(Object));
	});

	it("does not prompt for a non-live session", async () => {
		const ctx = context();
		livePid.mockReturnValue(undefined);
		await handleResumeSession(createFakeHost(ctx), "/tmp/other.jsonl");
		expect(ctx.showExtensionConfirm).not.toHaveBeenCalled();
		expect(ctx.runtimeHost.switchSession).toHaveBeenCalledOnce();
	});
});
