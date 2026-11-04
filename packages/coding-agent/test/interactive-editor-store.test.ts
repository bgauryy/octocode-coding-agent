import { Container, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { updateEditorBorderColor } from "../src/modes/interactive/interactive-mode/view-state.ts";
import { bindEditorState } from "../src/modes/interactive/state/bind-editor.ts";
import { bindRender } from "../src/modes/interactive/state/bind-render.ts";
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
	bindRender(uiStore, host.ui);
	return { host, uiStore, requestRender, invalidate, session };
}

describe("editor slice", () => {
	beforeAll(() => initTheme("dark"));

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
