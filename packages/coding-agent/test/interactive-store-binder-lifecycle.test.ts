import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createInteractiveModeHost } from "../src/modes/interactive/interactive-mode/create-host.ts";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { initTheme } from "../src/theme/theme.ts";

const settings = new Proxy(
	{
		getEditorPaddingX: () => 0,
		getAutocompleteMaxVisible: () => 5,
		getHideThinkingBlock: () => false,
		getTerminalCapabilityOverrides: () => ({}),
		getTuiMode: () => "main-screen",
	},
	{ get: (target, key) => (target as Record<PropertyKey, unknown>)[key] ?? (() => undefined) },
);

function createRealHost(): InteractiveModeHost {
	const session = {
		settingsManager: settings,
		sessionManager: { getCwd: () => process.cwd(), getSessionName: () => undefined },
		autoCompactionEnabled: false,
		resourceLoader: { getThemes: () => ({ themes: [] }) },
	};
	const runtimeHost = { session, setBeforeSessionInvalidate: vi.fn(), setRebindSession: vi.fn() };
	return createInteractiveModeHost(runtimeHost as unknown as AgentSessionRuntime, { tuiMode: "main-screen" } as never);
}

describe("UI store binders follow the host's lifetime", () => {
	beforeAll(() => initTheme("dark"));

	test("a store kept alive after the host stops no longer reaches the UI", () => {
		const host = createRealHost();
		const requestRender = vi.spyOn(host.renderer, "requestRender").mockImplementation(() => {});
		const showStatus = vi.spyOn(host, "showStatus").mockImplementation(() => {});
		const store = host.uiStore;

		store.getState().takeSlot({});
		expect(requestRender).toHaveBeenCalledTimes(1);

		host.stop();
		requestRender.mockClear();
		store.getState().clearSlot();
		store.getState().setHideThinking(true);
		store.getState().setToolsExpanded(true);

		expect(requestRender).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});

	test("the binders keep working until the host stops", () => {
		const host = createRealHost();
		const requestRender = vi.spyOn(host.renderer, "requestRender").mockImplementation(() => {});

		host.uiStore.getState().setToolsExpanded(true);

		expect(requestRender).toHaveBeenCalled();
		host.stop();
	});
});
