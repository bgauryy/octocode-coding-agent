import { describe, expect, it, vi } from "vitest";
import { rebindCurrentSession } from "../../../src/modes/interactive/interactive-mode/session-binding.ts";
import { createFakeHost } from "../../interactive-mode-host.ts";

type RebindContext = {
	session: object;
	unsubscribe?: () => void;
	applyRuntimeSettings: () => void;
	programStatus: { reset(): void };
	renderCurrentSessionState: () => void;
	bindCurrentSessionFeatures: () => Promise<void>;
	subscribeToAgent: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

describe("overlapping startup and replacement session rebinds", () => {
	it("does not subscribe from the stale startup rebind", async () => {
		const startupSession = {};
		const replacementSession = {};
		let resolveStartupBind!: () => void;
		let resolveReplacementBind!: () => void;

		const startupBind = new Promise<void>((resolve) => {
			resolveStartupBind = resolve;
		});
		const replacementBind = new Promise<void>((resolve) => {
			resolveReplacementBind = resolve;
		});

		const subscribeToAgent = vi.fn();
		const updateTerminalTitle = vi.fn();
		let bindCount = 0;

		const context: RebindContext = {
			session: startupSession,
			applyRuntimeSettings: () => {},
			programStatus: { reset: () => {} },
			renderCurrentSessionState: () => {},
			bindCurrentSessionFeatures: () => {
				bindCount += 1;
				return bindCount === 1 ? startupBind : replacementBind;
			},
			subscribeToAgent,
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle,
		};

		const startupRebind = rebindCurrentSession(createFakeHost(context));
		expect(bindCount).toBe(1);

		context.session = replacementSession;
		const replacementRebind = rebindCurrentSession(createFakeHost(context), {
			renderBeforeBind: true,
		});

		expect(bindCount).toBe(2);
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);

		resolveStartupBind();
		await startupRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		// Contract change (wave E): each rebind writes the plain title before its features bind (see below), so the stale
		// startup rebind wrote it while its session was still current, and writes nothing once it was replaced.
		expect(updateTerminalTitle).toHaveBeenCalledTimes(2);

		resolveReplacementBind();
		await replacementRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(2);
	});
});

describe("the terminal title after a rebind", () => {
	it("is the state title the features paint at session start, not the host's plain title over it", async () => {
		const titles: string[] = [];
		const context: RebindContext = {
			session: {},
			applyRuntimeSettings: () => {},
			programStatus: { reset: () => {} },
			renderCurrentSessionState: () => {},
			// The notifier paints its state title when the features see session_start.
			bindCurrentSessionFeatures: async () => void titles.push("◈ Idle - proj"),
			subscribeToAgent: () => {},
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle: () => void titles.push("Octocode · proj"),
		};
		await rebindCurrentSession(createFakeHost(context));
		expect(titles.at(-1)).toBe("◈ Idle - proj");
	});
});
