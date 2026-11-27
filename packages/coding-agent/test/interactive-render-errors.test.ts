import { type Component, Container, type TUI } from "@octocodeai/octocode-tui";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createInteractiveTui } from "../src/modes/interactive/interactive-mode.ts";
import {
	createRenderErrorNotices,
	installRenderErrorNotices,
} from "../src/modes/interactive/interactive-mode/render-errors.ts";
import { switchTuiMode } from "../src/modes/interactive/interactive-mode/view-state.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

class Exploding implements Component {
	private readonly message: string;
	constructor(message: string) {
		this.message = message;
	}
	render(): string[] {
		throw new Error(this.message);
	}
	invalidate(): void {}
}

/** Keeps the raw bytes, to check that no control sequence from the error reached the terminal. */
class RecordingTerminal extends VirtualTerminal {
	written = "";
	override write(data: string): void {
		this.written += data;
		super.write(data);
	}
}

const stopped: TUI[] = [];
const directories: string[] = [];

afterEach(() => {
	for (const tui of stopped.splice(0)) tui.stop();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

beforeAll(() => {
	initTheme("dark");
});

/** A real interactive renderer whose transcript is `chatContainer`, with the same `showError` interactive mode uses. */
function interactiveScreen() {
	const logDirectory = mkdtempSync(join(tmpdir(), "octocode-render-errors-"));
	directories.push(logDirectory);
	const terminal = new RecordingTerminal(100, 20);
	const renderer = createInteractiveTui({ tuiMode: "regular", showHardwareCursor: false, logDirectory, terminal });
	stopped.push(renderer);
	const chatContainer = new Container();
	renderer.addChild(chatContainer);
	// The fake host gets interactive mode's own `showError` (display.ts).
	const host = createFakeHost({ renderer, ui: renderer, chatContainer });
	const frames = async (count: number) => {
		for (let index = 0; index < count; index++) {
			renderer.requestRender();
			await terminal.waitForRender();
			// The notice is added after the frame that reported it.
			await Promise.resolve();
		}
	};
	// What the terminal shows; a direct render outside a frame would rethrow the component's error.
	const notices = async () =>
		(await terminal.flushAndGetViewport()).filter((line) => line.includes("Display failed")).map((line) => line.trim());
	const written = () => terminal.written;
	return { renderer, terminal, chatContainer, host, frames, notices, written, logDirectory };
}

describe("interactive render errors", () => {
	it("shows one sanitized notice for a component that fails on every frame", async () => {
		const screen = interactiveScreen();
		installRenderErrorNotices(screen.host);
		screen.chatContainer.addChild(new Exploding("boom \u001b]0;pwned\u0007\u009b31m title\nsecond line"));
		screen.renderer.start();

		await screen.frames(5);

		const notices = await screen.notices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("Display failed: Exploding could not render: boom");
		expect(notices[0]).not.toContain("second line");
		expect(screen.written()).not.toMatch(/\u001b\]0;pwned|\u009b31m/);
		// The error went to the transcript instead of the render error log.
		expect(readdirSync(screen.logDirectory)).toEqual([]);
	});

	it("keeps the listener when the renderer switches between regular and fullscreen", async () => {
		const screen = interactiveScreen();
		installRenderErrorNotices(screen.host);
		const listener = screen.renderer.onRenderError;
		Object.assign(screen.host, {
			options: { tuiMode: "regular" },
			settingsManager: {
				getFullscreenCopyOnSelect: () => false,
				getFullscreenWheelScrollLines: () => "auto",
				getReplayRows: () => 5000,
				isLatencyFenceActive: () => false,
				getFullscreenFrameQueueLimitBytes: () => 1 << 20,
			},
			themeController: { rebindTui: () => {} },
			fullscreenLayoutRoot: screen.chatContainer,
			featureTerminalInputSubscriptions: new Set(),
			mountInteractiveTui: (tui: TUI, components: Component[]) => {
				for (const component of components) tui.addChild(component);
			},
		});

		expect(switchTuiMode(screen.host, "fullscreen", false, false)).toBe(true);

		const next = (screen.host as unknown as { renderer: TUI }).renderer;
		stopped.push(next);
		expect(next).not.toBe(screen.renderer);
		expect(next.onRenderError).toBe(listener);
	});

	it("does not recurse when showing the notice throws or the notice itself fails to render", async () => {
		const tasks: Array<() => void> = [];
		const throwingShow = createRenderErrorNotices(
			() => {
				throw new Error("transcript gone");
			},
			(task) => tasks.push(task),
		);
		const failing = new Exploding("boom");
		throwingShow(new Error("boom"), failing);
		throwingShow(new Error("boom"), failing);
		expect(tasks).toHaveLength(1);
		expect(() => tasks[0]?.()).not.toThrow();

		// A notice component that itself throws: each new notice reports the same failure, which is shown only once.
		const screen = interactiveScreen();
		let shown = 0;
		screen.renderer.onRenderError = createRenderErrorNotices(() => {
			shown++;
			screen.chatContainer.addChild(new Exploding("notice broke"));
		});
		screen.chatContainer.addChild(new Exploding("first"));
		screen.renderer.start();

		await screen.frames(6);

		expect(shown).toBe(2);
		expect(screen.chatContainer.children).toHaveLength(3);
	});
});
