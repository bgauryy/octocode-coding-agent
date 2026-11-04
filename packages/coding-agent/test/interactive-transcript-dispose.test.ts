import { Container, animationClock, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { disposeTranscript } from "../src/modes/interactive/interactive-mode/transcript-dispose.ts";
import { renderCurrentSessionState } from "../src/modes/interactive/interactive-mode/session-binding.ts";
import { showTreeNavigationResult } from "../src/modes/interactive/interactive-mode/session-navigation.ts";
import { toolTimerText, startToolTimer } from "../src/core/tools/render-utils.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const ROWS = 20;

function fakeUi() {
	return { requestRender: vi.fn() } as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };
}

function runningRows(ui: TUI, chat: Container): void {
	for (let i = 0; i < ROWS; i++) chat.addChild(new BashExecutionComponent(`sleep ${i}`, ui));
	const timed = {
		renderCall: (_a: unknown, _t: unknown, ctx: any) => {
			startToolTimer(ctx);
			return { render: () => [], invalidate() {} };
		},
		renderResult: (_r: unknown, o: { isPartial: boolean }, _t: unknown, ctx: any) => {
			toolTimerText(ctx, o.isPartial);
			return { render: () => [], invalidate() {} };
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

	it("the rows keep the clock running while mounted", async () => {
		const ui = fakeUi();
		const chat = new Container();
		runningRows(ui, chat);
		expect(animationClock.isRunning()).toBe(true);
		disposeTranscript(chat);
		chat.clear();
		await expectQuiet(ui);
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
