import { animationClock, Container, type TUI } from "@octocodeai/octocode-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { updateEditorBorderColor } from "../src/modes/interactive/interactive-mode/view-state.ts";
import { bindEditorState } from "../src/modes/interactive/state/bind-editor.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const paint = (color: ((text: string) => string) | undefined) => color?.("x");

function setup(thinkingLevel: string = "off") {
	const uiStore = createUiStore();
	const requestRender = vi.fn();
	const invalidate = vi.fn();
	const session = { thinkingLevel };
	const host = createFakeHost({
		uiStore,
		ui: { requestRender } as unknown as TUI,
		editor: {},
		editorContainer: new Container(),
		activeStatusIndicator: { invalidate },
		session,
	});
	bindEditorState(host);
	return { host, uiStore, requestRender, invalidate, session };
}

describe("editor slice", () => {
	// Reduced motion paints a tone at once; the fade has its own tests below.
	beforeAll(() => {
		initTheme("dark");
		animationClock.setReducedMotion(true);
	});
	afterAll(() => animationClock.setReducedMotion(false));

	it("paints the bash border once when bash mode starts and the thinking border when it ends", () => {
		const { host, uiStore, requestRender, invalidate } = setup();

		uiStore.getState().setBashMode(true);
		expect(paint(host.editor.borderColor)).toBe(paint(theme.getBashModeBorderColor()));
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);

		uiStore.getState().setBashMode(true);
		expect(requestRender).toHaveBeenCalledTimes(1);

		uiStore.getState().setBashMode(false);
		expect(paint(host.editor.borderColor)).toBe(paint(theme.getThinkingBorderColor("off")));
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("follows the session thinking level through updateEditorBorderColor", () => {
		const { host, session, requestRender } = setup();

		session.thinkingLevel = "high";
		updateEditorBorderColor(host);
		expect(paint(host.editor.borderColor)).toBe(paint(theme.getThinkingBorderColor("high")));
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("repaints with the same tone after a theme change", () => {
		const { host, requestRender } = setup();

		updateEditorBorderColor(host);
		expect(paint(host.editor.borderColor)).toBe(paint(theme.getThinkingBorderColor("off")));
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint while bash mode hides a thinking level change", () => {
		const { host, uiStore, session, invalidate } = setup();
		uiStore.getState().setBashMode(true);
		invalidate.mockClear();

		session.thinkingLevel = "high";
		updateEditorBorderColor(host);
		expect(invalidate).not.toHaveBeenCalled();
		expect(paint(host.editor.borderColor)).toBe(paint(theme.getBashModeBorderColor()));
	});
});

describe("editor border fade", () => {
	beforeAll(() => {
		vi.stubEnv("NO_COLOR", "");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("COLORTERM", "truecolor");
		initTheme("dark");
	});
	afterAll(() => vi.unstubAllEnvs());
	afterEach(() => vi.useRealTimers());

	it("passes through mixed colors and settles on the new tone's own painter", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
		const { host, uiStore, requestRender } = setup();
		const before = paint(theme.getThinkingBorderColor("off"));
		const after = paint(theme.getBashModeBorderColor());
		expect(before).not.toBe(after);

		uiStore.getState().setBashMode(true);
		await vi.advanceTimersByTimeAsync(100);
		const middle = paint(host.editor.borderColor);
		expect(middle).not.toBe(before);
		expect(middle).not.toBe(after);

		await vi.advanceTimersByTimeAsync(400);
		expect(paint(host.editor.borderColor)).toBe(after);
		const renders = requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(400);
		// A settled border stops repainting.
		expect(requestRender.mock.calls.length).toBe(renders);
	});

	it("paints at once in reduced motion", () => {
		animationClock.setReducedMotion(true);
		try {
			const { host, uiStore } = setup();
			uiStore.getState().setBashMode(true);
			expect(paint(host.editor.borderColor)).toBe(paint(theme.getBashModeBorderColor()));
		} finally {
			animationClock.setReducedMotion(false);
		}
	});
});
