/**
 * Dialogs features open in place of the editor: selectors, confirmations, text input, the multi-line editor and
 * custom components, plus the missing-cwd prompt that uses the same selector.
 */

import type { OverlayHandle, OverlayOptions, Component, TUI } from "@octocodeai/octocode-tui";
import type { DialogOptions } from "../../../core/features/index.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../../../core/session-cwd.ts";
import { DialogEditorComponent } from "../components/dialog-editor.ts";
import { DialogInputComponent } from "../components/dialog-input.ts";
import { confirmInAsk } from "../../../octocode/ask/confirm.ts";
import { DialogSelectorComponent } from "../components/dialog-selector.ts";
import type { BlockedStatus } from "../program-status-reporter.ts";
import { type Theme, theme } from "../../../theme/theme.ts";
import { openDialog, takeOpenDialog, takeSlot } from "./dialog-slot.ts";
import type { InteractiveModeHost, SelectorCard } from "./host.ts";

/** Interactive-mode members used by the feature dialogs. */
type DialogsHost = Pick<
	InteractiveModeHost,
	| "activeSelectorDispose"
	| "activeStatusIndicator"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "disposeActiveSelector"
	| "editor"
	| "editorContainer"
	| "editorDialog"
	| "inputDialog"
	| "selectorDialog"
	| "hideEditorDialog"
	| "hideInputDialog"
	| "hideSelectorDialog"
	| "keybindings"
	| "programStatus"
	| "session"
	| "settingsManager"
	| "showConfirmDialog"
	| "showCustomDialog"
	| "showSelectorDialog"
	| "toggleToolOutputExpansion"
	| "ui"
	| "uiStore"
>;

/** Each host's open custom overlays, closed (answered with no value) by `closeDialogOverlays`. */
const openOverlays = new WeakMap<object, Set<() => void>>();

/**
 * Answer every custom overlay open on `host` with no value, as the reset on reload or session replacement does, and
 * report whether there was one.
 */
export function closeDialogOverlays(host: object): boolean {
	const closes = [...(openOverlays.get(host) ?? [])];
	for (const close of closes) close();
	return closes.length > 0;
}

/**
 * Show a selector for features. `blocked` is what the footer reports while it is open (a question unless the caller
 * says otherwise); `card` draws it as an ask card (`ask-dialog.ts` shows approvals this way).
 */
export function showSelectorDialog(
	host: DialogsHost,
	title: string,
	options: string[],
	opts?: DialogOptions,
	blocked: BlockedStatus = { kind: "question", message: title },
	card?: SelectorCard,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = openDialog(host, resolve, () => host.hideSelectorDialog(), opts?.signal);
		host.selectorDialog = new DialogSelectorComponent(title, options, finish, () => finish(undefined), {
			tui: host.ui,
			timeout: opts?.timeout,
			...(card ? { ask: card.view, ...(card.onWriteIn ? { onWriteIn: card.onWriteIn } : {}) } : {}),
			onToggleToolsExpanded: () => host.toggleToolOutputExpansion(),
			// A dialog that opens mid-run (an approval) keeps what the user types: it is submitted as if typed in the editor
			// (dialog unit tests build hosts without a session).
			onSubmitText: host.session?.isStreaming ? (text) => host.defaultEditor.onSubmit?.(text) : undefined,
		});

		host.editorContainer.clear();
		host.editorContainer.addChild(host.selectorDialog);
		host.ui.setFocus(host.selectorDialog);
		// Feature dialogs share the editor slot: opening one replaces the status of a displaced one.
		host.programStatus.setBlocked("feature-dialog", blocked);
		host.ui.requestRender();
	});
}

/**
 * Hide the feature selector.
 */
export function hideSelectorDialog(host: DialogsHost): void {
	const cancel = takeOpenDialog(host);
	if (cancel) return cancel();
	host.selectorDialog?.dispose();
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
	host.selectorDialog = undefined;
	host.programStatus.setBlocked("feature-dialog", undefined);
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

/**
 * Show a confirmation in the tabbed ask dialog (`octocode/ask/confirm.ts`): the title as its question, the message as its
 * body, No first. The footer reports a question while it is open.
 */
export async function showConfirmDialog(
	host: DialogsHost,
	title: string,
	message: string,
	opts?: DialogOptions,
): Promise<boolean> {
	if (opts?.signal?.aborted) return false;
	const clear = () => host.programStatus.setBlocked("feature-dialog", undefined);
	host.programStatus.setBlocked("feature-dialog", { kind: "question", message: title });
	try {
		return await confirmInAsk(
			{ ui: { custom: (factory, options) => host.showCustomDialog(factory, options) } },
			title,
			message,
			opts,
			clear,
		);
	} catch (error) {
		// Its factory failed, so nothing disposed the dialog (once open, disposal runs `clear` before a successor reports).
		clear();
		throw error;
	}
}

export async function promptForMissingSessionCwd(
	host: DialogsHost,
	error: MissingSessionCwdError,
): Promise<string | undefined> {
	const confirmed = await host.showConfirmDialog("Session cwd not found", formatMissingSessionCwdPrompt(error.issue));
	return confirmed ? error.issue.fallbackCwd : undefined;
}

/**
 * Show a text input for features.
 */
export function showInputDialog(
	host: DialogsHost,
	title: string,
	placeholder?: string,
	opts?: DialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = openDialog(host, resolve, () => host.hideInputDialog(), opts?.signal);
		host.inputDialog = new DialogInputComponent(title, placeholder, finish, () => finish(undefined), {
			tui: host.ui,
			timeout: opts?.timeout,
		});

		host.editorContainer.clear();
		host.editorContainer.addChild(host.inputDialog);
		host.ui.setFocus(host.inputDialog);
		host.programStatus.setBlocked("feature-dialog", { kind: "question", message: title });
		host.ui.requestRender();
	});
}

/**
 * Hide the feature input.
 */
export function hideInputDialog(host: DialogsHost): void {
	const cancel = takeOpenDialog(host);
	if (cancel) return cancel();
	host.inputDialog?.dispose();
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
	host.inputDialog = undefined;
	host.programStatus.setBlocked("feature-dialog", undefined);
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

/**
 * Show a multi-line editor for features (with Ctrl+G support).
 */
export function showEditorDialog(
	host: DialogsHost,
	title: string,
	prefill?: string,
	opts?: DialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = openDialog(host, resolve, () => host.hideEditorDialog(), opts?.signal);
		host.editorDialog = new DialogEditorComponent(
			host.ui,
			host.keybindings,
			title,
			prefill,
			finish,
			() => finish(undefined),
			undefined,
			host.settingsManager.getExternalEditorCommand(),
		);

		host.editorContainer.clear();
		host.editorContainer.addChild(host.editorDialog);
		host.ui.setFocus(host.editorDialog);
		host.programStatus.setBlocked("feature-dialog", { kind: "question", message: title });
		host.ui.requestRender();
	});
}

/**
 * Hide the feature editor.
 */
export function hideEditorDialog(host: DialogsHost): void {
	const cancel = takeOpenDialog(host);
	if (cancel) return cancel();
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
	host.editorDialog = undefined;
	host.programStatus.setBlocked("feature-dialog", undefined);
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

/**
 * Show a custom component with keyboard focus. Overlay mode renders on top of existing content; otherwise the
 * component takes the editor slot. It resolves with the component's result, or undefined when something else takes its
 * slot or the reset closes it; either way it is disposed once.
 */
export async function showCustomDialog<T>(
	host: DialogsHost,
	factory: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	options?: {
		overlay?: boolean;
		overlayOptions?: OverlayOptions | (() => OverlayOptions);
		onHandle?: (handle: OverlayHandle) => void;
	},
): Promise<T | undefined> {
	const savedText = host.editor.getText();
	const savedExpanded = host.editor.getExpandedText?.() ?? savedText;
	const isOverlay = options?.overlay ?? false;

	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		// An untouched draft stays as it is, paste markers included; a changed one gets the saved text back, expanded.
		if (host.editor.getText() !== savedText) host.editor.setText(savedExpanded);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	return new Promise((resolve, reject) => {
		let component: Component & { dispose?(): void };
		let overlayHandle: OverlayHandle | undefined;
		let release: (() => void) | undefined;
		let closed = false;

		const close = (result: T | undefined) => {
			if (closed) return;
			closed = true;
			release?.();
			// Remove this overlay, not the topmost one: another overlay may have opened above it.
			if (isOverlay) overlayHandle?.hide();
			else restoreEditor();
			// Note: both branches above already call requestRender
			resolve(result);
			try {
				component?.dispose?.();
			} catch {
				/* ignore dispose errors */
			}
		};

		Promise.resolve(factory(host.ui, theme, host.keybindings, close))
			.then((c) => {
				// `done` ran before the factory returned: `close` had no component to dispose, so dispose it here.
				if (closed) {
					try {
						c.dispose?.();
					} catch {
						/* ignore dispose errors */
					}
					return;
				}
				component = c;
				if (isOverlay) {
					// Resolve overlay options - can be static or dynamic function
					const resolveOptions = (): OverlayOptions | undefined => {
						if (options?.overlayOptions) {
							const opts =
								typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
							return opts;
						}
						// Fallback: use component's width property if available
						const w = (component as { width?: number }).width;
						return w ? { width: w } : undefined;
					};
					overlayHandle = host.ui.showOverlay(component, resolveOptions());
					const overlays = openOverlays.get(host) ?? new Set<() => void>();
					openOverlays.set(host, overlays);
					const cancel = () => close(undefined);
					overlays.add(cancel);
					release = () => overlays.delete(cancel);
					// Expose handle to caller for visibility control
					options?.onHandle?.(overlayHandle);
				} else {
					release = takeSlot(host, () => close(undefined));
					host.editorContainer.clear();
					host.editorContainer.addChild(component);
					host.ui.setFocus(component);
					host.ui.requestRender();
				}
			})
			.catch((err) => {
				if (closed) return;
				if (!isOverlay) restoreEditor();
				reject(err);
			});
	});
}
