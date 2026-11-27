import { Container, Text } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import { getEditorSlot } from "../src/modes/interactive/interactive-mode/dialog-slot.ts";
import * as dialogs from "../src/modes/interactive/interactive-mode/dialogs.ts";
import { showSelector } from "../src/modes/interactive/interactive-mode/view-state.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function makeSlotHost() {
	const editor = new Text("editor", 0, 0);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const setBlocked = vi.fn();
	const host = createFakeHost({
		editor: Object.assign(editor, {
			getText: () => "",
			setText: vi.fn(),
		}),
		defaultEditor: editor,
		editorContainer,
		activeSelectorDispose: undefined,
		activeStatusIndicator: undefined,
		selectorDialog: undefined,
		inputDialog: undefined,
		editorDialog: undefined,
		programStatus: { setBlocked },
		session: { isStreaming: false },
		settingsManager: { getExternalEditorCommand: () => undefined },
		ui: {
			setFocus,
			requestRender,
			terminal: {},
			showOverlay: vi.fn(),
			hideOverlay: vi.fn(),
		},
	});
	return { host, editor, editorContainer, setFocus, requestRender, setBlocked };
}

describe("EditorSlot state machine", () => {
	it("suspends and restores the parent when a stacked sub-prompt closes", () => {
		const { host, editor, editorContainer, setFocus, setBlocked } = makeSlotHost();
		const slot = getEditorSlot(host);
		const parentComp = new Text("parent", 0, 0);
		const parentDispose = vi.fn();
		const parentCancel = vi.fn();
		const parentLease = slot.acquire({
			cancel: parentCancel,
			blocked: { kind: "question", message: "Parent" },
		});
		expect(parentLease.mount(parentComp, parentComp, parentDispose)).toBe(true);
		expect(editorContainer.peekChildren()).toEqual([parentComp]);

		const childComp = new Text("child", 0, 0);
		const childDispose = vi.fn();
		const childCancel = vi.fn();
		const childLease = slot.acquire({
			cancel: childCancel,
			blocked: { kind: "question", message: "Child" },
			stack: true,
		});
		expect(parentCancel).not.toHaveBeenCalled();
		expect(parentDispose).not.toHaveBeenCalled();
		expect(childLease.mount(childComp, childComp, childDispose)).toBe(true);
		expect(editorContainer.peekChildren()).toEqual([childComp]);
		expect(setBlocked).toHaveBeenLastCalledWith("feature-dialog", { kind: "question", message: "Child" });

		// Releasing the stacked child restores the live parent component, focus, and blocked status.
		expect(childLease.release()).toBe(true);
		expect(childDispose).toHaveBeenCalledOnce();
		expect(parentDispose).not.toHaveBeenCalled();
		expect(editorContainer.peekChildren()).toEqual([parentComp]);
		expect(setFocus).toHaveBeenLastCalledWith(parentComp);
		expect(setBlocked).toHaveBeenLastCalledWith("feature-dialog", { kind: "question", message: "Parent" });

		// Releasing the parent restores the chat editor.
		expect(parentLease.release()).toBe(true);
		expect(parentDispose).toHaveBeenCalledOnce();
		expect(editorContainer.peekChildren()).toEqual([editor]);
		expect(setFocus).toHaveBeenLastCalledWith(editor);
		expect(setBlocked).toHaveBeenLastCalledWith("feature-dialog", undefined);
	});

	it("disposes both stacked child and suspended parent on disposeAll()", () => {
		const { host } = makeSlotHost();
		const slot = getEditorSlot(host);
		const parentCancel = vi.fn();
		const parentDispose = vi.fn();
		const parentLease = slot.acquire({ cancel: parentCancel });
		parentLease.mount(new Text("parent", 0, 0), undefined, parentDispose);

		const childCancel = vi.fn();
		const childDispose = vi.fn();
		const childLease = slot.acquire({ cancel: childCancel, stack: true });
		childLease.mount(new Text("child", 0, 0), undefined, childDispose);

		slot.disposeAll();
		expect(childCancel).toHaveBeenCalledOnce();
		expect(childDispose).toHaveBeenCalledOnce();
		expect(parentCancel).toHaveBeenCalledOnce();
		expect(parentDispose).toHaveBeenCalledOnce();
	});

	it("does not leak the slot when showSelector's factory calls done() synchronously", () => {
		const { host, editor, editorContainer } = makeSlotHost();
		const dispose = vi.fn();
		showSelector(host, (done) => {
			done();
			return { component: new Text("sync", 0, 0), focus: new Text("sync", 0, 0), dispose };
		});
		expect(dispose).toHaveBeenCalledOnce();
		expect(editorContainer.peekChildren()).toEqual([editor]);
		expect(host.uiStore.getState().overlay.slot).toBeUndefined();
	});

	it("prevents an older async custom dialog from clobbering a newer dialog", async () => {
		const { host, editorContainer } = makeSlotHost();
		let resolveOlder!: (c: Text & { dispose: () => void }) => void;
		const olderDispose = vi.fn();
		const older = dialogs.showCustomDialog(
			host,
			() =>
				new Promise((resolve) => {
					resolveOlder = resolve;
				}),
		);

		const newerComp = new Text("newer", 0, 0);
		let closeNewer!: (v: string) => void;
		const newer = dialogs.showCustomDialog<string>(host, (_tui, _theme, _kb, done) => {
			closeNewer = done;
			return newerComp;
		});

		await expect(older).resolves.toBeUndefined();
		resolveOlder(Object.assign(new Text("older", 0, 0), { dispose: olderDispose }));
		await Promise.resolve();

		expect(olderDispose).toHaveBeenCalledOnce();
		expect(editorContainer.peekChildren()).toEqual([newerComp]);
		closeNewer("ok");
		await expect(newer).resolves.toBe("ok");
	});
});
