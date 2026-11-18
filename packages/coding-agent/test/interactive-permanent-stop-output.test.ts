import { Container, animationClock, type Component, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stop } from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { mountInteractiveTui } from "../src/modes/interactive/interactive-mode/view-state.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";
import { resultBlock, toolHeader } from "../src/octocode/render/tool.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

/** A virtual terminal that also keeps every byte written to it. */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("permanent stop from fullscreen writes the transcript and then stops live rows", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		initTheme("dark");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("leaves the alternate screen, keeps nested rows' last content in the output and silences the clock", async () => {
		const terminal = new RecordingTerminal(100, 30);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: ".octocode/tmp",
			terminal,
		});
		const ui = renderer as unknown as TUI;
		const requestRender = vi.spyOn(renderer, "requestRender");

		const chat = new Container();
		const nested = new Container();
		const bash = new BashExecutionComponent("sleep 99", ui);
		bash.appendOutput("first bash line\n");
		bash.appendOutput("LAST-BASH-OUTPUT\n");
		const unsubscribe = vi.fn();
		const timedTool = new ToolExecutionComponent(
			"timed",
			"id-timed",
			{},
			{},
			{
				renderCall: (_a: unknown, _t: unknown, ctx: any) => {
					return toolHeader(theme, { ...ctx, toolCallId: undefined }, "TIMED-CALL-HEADER", "");
				},
				renderResult: (_r: unknown, o: { isPartial: boolean }, _t: unknown, ctx: any) => {
					return resultBlock(theme, ctx, { summary: `TIMED-RESULT ${o.isPartial ? "running" : "done"}` });
				},
			} as any,
			ui,
			process.cwd(),
		);
		timedTool.markExecutionStarted();
		timedTool.updateResult({ content: [], isError: false }, true);
		const inner = new Container();
		inner.addChild(bash);
		inner.addChild(timedTool);
		nested.addChild(inner);
		chat.addChild(nested);
		expect(animationClock.isRunning()).toBe(true);

		const host = createFakeHost({
			renderer,
			get ui() {
				return this.renderer;
			},
			chatContainer: chat,
			loadedResourcesContainer: new Container(),
			fullscreenLayoutRoot: chat as Component,
			mainScreenRenderState: undefined,
			options: { tuiMode: "fullscreen" },
			settingsManager: {
				getShowTerminalProgress: () => false,
				getFullscreenCopyOnSelect: () => false,
				getFullscreenWheelScrollLines: () => "auto",
				getReplayRows: () => 5000,
			},
			themeController: { disableAutoSync: vi.fn(), rebindTui: vi.fn() },
			forEachAssistantMessage: vi.fn(),
			disposeActiveSelector: vi.fn(),
			clearStatusIndicator: vi.fn(),
			clearFeatureTerminalInputListeners: vi.fn(),
			rebindFeatureTerminalInputListeners: vi.fn(),
			footerDataProvider: { dispose: vi.fn() },
			unsubscribe,
			isInitialized: true,
			unregisterSignalHandlers: vi.fn(),
			onRightClickPaste: undefined,
			mountInteractiveTui: (tui: any, components: readonly Component[]) => mountInteractiveTui(host, tui, components),
		} as any);

		renderer.addChild(chat);
		renderer.setLayoutRoot(chat);
		renderer.start();
		renderer.renderNow();
		expect(terminal.writes.join("")).toContain(ENTER_ALT_SCREEN);
		expect(terminal.writes.join("")).not.toContain(EXIT_ALT_SCREEN);

		const writesBeforeStop = terminal.writes.length;
		stop(host, "transcript");
		const stopOutput = terminal.writes.slice(writesBeforeStop).join("");

		// The final transcript is written, with the rows' last content, before the screen is left for good.
		expect(stopOutput).toContain("LAST-BASH-OUTPUT");
		expect(stopOutput).toContain("TIMED-CALL-HEADER");
		expect(stopOutput).toContain("TIMED-RESULT running");
		expect(stopOutput).toContain(EXIT_ALT_SCREEN);
		// The transcript goes to the regular screen, so it follows the alternate-screen exit.
		expect(stopOutput.indexOf(EXIT_ALT_SCREEN)).toBeLessThan(stopOutput.indexOf("LAST-BASH-OUTPUT"));
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(host.isInitialized).toBe(false);

		// Afterwards the shared clock is stopped and nothing asks for a render.
		expect(animationClock.isRunning()).toBe(false);
		requestRender.mockClear();
		const bytesAfterStop = terminal.writes.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(requestRender).not.toHaveBeenCalled();
		expect(terminal.writes.length).toBe(bytesAfterStop);
	});
});
