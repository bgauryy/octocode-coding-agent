import { Container, animationClock, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { disposeTranscript } from "../src/modes/interactive/interactive-mode/transcript-dispose.ts";
import { stop } from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { renderCurrentSessionState } from "../src/modes/interactive/interactive-mode/session-binding.ts";
import { showTreeNavigationResult } from "../src/modes/interactive/interactive-mode/session-navigation.ts";
import { resultBlock, toolHeader } from "../src/octocode/render/tool.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

const ROWS = 20;

function fakeUi() {
	return { requestRender: vi.fn() } as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };
}

function runningRows(ui: TUI, chat: Container): void {
	for (let i = 0; i < ROWS; i++) chat.addChild(new BashExecutionComponent(`sleep ${i}`, ui));
	const timed = {
		renderCall: (_a: unknown, _t: unknown, ctx: any) => {
			return toolHeader(theme, { ...ctx, toolCallId: undefined }, "timed", "");
		},
		renderResult: (_r: unknown, o: { isPartial: boolean }, _t: unknown, ctx: any) => {
			return resultBlock(theme, ctx, { summary: o.isPartial ? "running" : "done" });
		},
	};
	for (let i = 0; i < ROWS; i++) {
		const row = new ToolExecutionComponent(`t${i}`, `id${i}`, {}, {}, timed as any, ui, process.cwd());
		row.markExecutionStarted();
		row.updateResult({ content: [], isError: false }, true);
		chat.addChild(row);
	}
}

describe("transcript rows are disposed when dropped", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		initTheme("dark");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function expectQuiet(ui: ReturnType<typeof fakeUi>) {
		expect(animationClock.isRunning()).toBe(false);
		ui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(3000);
		expect(ui.requestRender).not.toHaveBeenCalled();
	}

	it("retains a nested live tool while disposing its old parent and siblings", () => {
		const chat = new Container();
		const parent = Object.assign(new Container(), { dispose: vi.fn() });
		const kept = { render: () => [], invalidate() {}, dispose: vi.fn() };
		const dropped = { render: () => [], invalidate() {}, dispose: vi.fn() };
		parent.addChild(kept);
		parent.addChild(dropped);
		chat.addChild(parent);
		disposeTranscript(chat, [kept]);
		expect(parent.dispose).toHaveBeenCalledOnce();
		expect(dropped.dispose).toHaveBeenCalledOnce();
		expect(kept.dispose).not.toHaveBeenCalled();
		chat.clear();
		chat.addChild(kept);
		disposeTranscript(chat);
		expect(kept.dispose).toHaveBeenCalledOnce();
	});

	it("the rows keep the clock running while mounted", async () => {
		const ui = fakeUi();
		const chat = new Container();
		runningRows(ui, chat);
		expect(animationClock.isRunning()).toBe(true);
		disposeTranscript(chat);
		chat.clear();
		await expectQuiet(ui);
	});

	it("permanent stop releases live rows after final output without dropping the transcript", async () => {
		const ui = fakeUi();
		const chat = new Container();
		runningRows(ui, chat);
		const rows = [...chat.children];
		const host = createFakeHost({
			ui,
			chatContainer: chat,
			loadedResourcesContainer: new Container(),
			settingsManager: { getShowTerminalProgress: () => false },
			disposeActiveSelector: vi.fn(),
			clearStatusIndicator: vi.fn(),
			themeController: { disableAutoSync: vi.fn() },
			clearFeatureTerminalInputListeners: vi.fn(),
			footerDataProvider: { dispose: vi.fn() },
			unsubscribe: vi.fn(),
			uiStore: createUiStore({ lifecycle: { initialized: true } }),
			stopInteractiveTui: vi.fn(() => {
				expect(animationClock.isRunning()).toBe(true);
				expect(chat.children).toEqual(rows);
			}),
			unregisterSignalHandlers: vi.fn(),
		});
		try {
			stop(host, "transcript");
			expect(host.stopInteractiveTui).toHaveBeenCalledWith("transcript");
			expect(chat.children).toEqual(rows);
			await expectQuiet(ui);
			stop(host, "transcript");
			expect(host.stopInteractiveTui).toHaveBeenCalledTimes(1);
			await expectQuiet(ui);
		} finally {
			disposeTranscript(chat);
		}
	});

	it("renderCurrentSessionState stops them", async () => {
		const ui = fakeUi();
		const chat = new Container();
		runningRows(ui, chat);
		const host = createFakeHost({
			loadedResourcesContainer: new Container(),
			chatContainer: chat,
			pendingMessagesContainer: new Container(),
			pendingTools: new Map(),
			renderInitialMessages: vi.fn(),
		});
		renderCurrentSessionState(host);
		await expectQuiet(ui);
	});

	it("tree navigation stops them", async () => {
		const ui = fakeUi();
		const chat = new Container();
		runningRows(ui, chat);
		showTreeNavigationResult(
			{
				chatContainer: chat,
				editor: { getText: () => "", setText: vi.fn() },
				flushCompactionQueue: vi.fn(async () => {}),
				renderInitialMessages: vi.fn(),
				showStatus: vi.fn(),
			} as any,
			undefined,
		);
		await expectQuiet(ui);
	});
});
