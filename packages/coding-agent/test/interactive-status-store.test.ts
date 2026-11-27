import { Container, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionUI } from "../src/modes/interactive/interactive-mode/session-ui.ts";
import {
	clearStatusIndicator,
	setWorkingIndicator,
	showManagedToolStatus,
	showWorkingStatusIndicator,
} from "../src/modes/interactive/interactive-mode/status-indicators.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { bindStatusIndicator } from "../src/modes/interactive/state/bind-status.ts";
import { selectWorkingIndicator, selectWorkingMessage } from "../src/modes/interactive/state/status-slice.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function setup() {
	const host = createFakeHost({
		uiStore: createUiStore(),
		ui: { requestRender: vi.fn(), getClearOnShrink: () => false } as unknown as TUI,
		chatContainer: new Container(),
		statusContainer: new Container(),
		editor: {},
		defaultEditor: { setWorkingStatusIndicator: vi.fn() },
		session: { thinkingLevel: "off" },
		activeStatusIndicator: undefined as StatusIndicator | undefined,
		options: { tuiMode: "main-screen" },
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
	});
	// The mode's host mounts indicators through this binder for its lifetime.
	bindStatusIndicator(host);
	return host;
}

const statusText = (host: ReturnType<typeof setup>) => stripAnsi(host.statusContainer.render(120).join("\n"));

describe("status slice", () => {
	beforeAll(() => initTheme("dark"));
	let host: ReturnType<typeof setup> | undefined;
	afterEach(() => {
		if (host) clearStatusIndicator(host);
		host = undefined;
	});

	it("keeps a feature's working message for the indicator shown now and every later one, until it is cleared", () => {
		host = setup();
		const ui = createSessionUI(host);

		ui.setWorkingMessage("Indexing files");
		showWorkingStatusIndicator(host);
		expect(statusText(host)).toContain("Indexing files");

		showWorkingStatusIndicator(host);
		expect(statusText(host)).toContain("Indexing files");

		ui.setWorkingMessage(undefined);
		expect(statusText(host)).toContain("Working");
		expect(statusText(host)).not.toContain("Indexing files");
		expect(selectWorkingMessage(host.uiStore.getState())).toBe("Working");
	});

	it("keeps a feature's indicator frames for later indicators", () => {
		host = setup();
		const frames = { frames: ["*"], intervalMs: 100 };

		setWorkingIndicator(host, frames);
		expect(selectWorkingIndicator(host.uiStore.getState())).toBe(frames);
		setWorkingIndicator(host);
		expect(selectWorkingIndicator(host.uiStore.getState())).toBeUndefined();
	});

	it("opens the managed-tool status group with one spacer for the host's lifetime", () => {
		host = setup();

		showManagedToolStatus(host, { type: "info", message: "fd downloading" });
		showManagedToolStatus(host, { type: "info", message: "rg downloading" });

		expect(host.chatContainer.children).toHaveLength(3);
		expect(host.uiStore.getState().startManagedToolStatus()).toBe(false);
	});
});
