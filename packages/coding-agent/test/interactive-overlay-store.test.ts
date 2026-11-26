import { Container, Text, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { disposeActiveSelector, showSelector } from "../src/modes/interactive/interactive-mode/view-state.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function setup() {
	const uiStore = createUiStore();
	const requestRender = vi.fn();
	const editor = new Text("EDITOR");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const ui = { requestRender, setFocus: vi.fn() } as unknown as TUI;
	const host = createFakeHost({
		uiStore,
		ui,
		editor,
		editorContainer,
		activeSelectorDispose: undefined,
	});
	const screen = () => stripAnsi(editorContainer.render(40).join("\n"));
	return { host, uiStore, requestRender, screen };
}

describe("overlay slice", () => {
	beforeAll(() => initTheme("dark"));

	it("shows the selector in the editor slot and requests one frame for it", () => {
		const { host, uiStore, requestRender, screen } = setup();
		const selector = new Text("PICK ONE");

		showSelector(host, () => ({ component: selector, focus: selector }));

		expect(screen()).toContain("PICK ONE");
		expect(uiStore.getState().overlay.slot).toBeDefined();
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("returns the editor and frees the slot when the selector is done", () => {
		const { host, uiStore, requestRender, screen } = setup();
		let finish: () => void = () => {};
		const selector = new Text("PICK ONE");
		showSelector(host, (done) => {
			finish = done;
			return { component: selector, focus: selector };
		});
		requestRender.mockClear();

		finish();
		expect(screen()).toContain("EDITOR");
		expect(uiStore.getState().overlay.slot).toBeUndefined();
		expect(requestRender).toHaveBeenCalledTimes(1);

		finish();
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("disposing a displaced selector frees the slot once and a second dispose changes nothing", () => {
		const { host, uiStore, requestRender } = setup();
		const dispose = vi.fn();
		const selector = new Text("PICK ONE");
		showSelector(host, () => ({ component: selector, focus: selector, dispose }));
		requestRender.mockClear();

		disposeActiveSelector(host);
		expect(dispose).toHaveBeenCalledOnce();
		expect(uiStore.getState().overlay.slot).toBeUndefined();
		expect(requestRender).toHaveBeenCalledTimes(1);

		disposeActiveSelector(host);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("a stale release does not free the slot of a newer holder", () => {
		const { uiStore } = setup();
		const first = {};
		const second = {};
		uiStore.getState().takeSlot(first);
		uiStore.getState().takeSlot(second);

		expect(uiStore.getState().releaseSlot(first)).toBe(false);
		expect(uiStore.getState().overlay.slot).toBe(second);
	});
});
