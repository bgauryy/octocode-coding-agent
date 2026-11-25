import { captureCommandDialog } from "./web-command-context.ts";
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
import { getEditorSlot, openDialog, type SlotLease } from "./dialog-slot.ts";
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
	opts?: DialogOptions & { stack?: boolean },
	blocked: BlockedStatus = { kind: "question", message: title },
	card?: SelectorCard,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const { lease, finish } = openDialog(
			host,
			resolve,
			() => {
				host.selectorDialog?.dispose();
				host.selectorDialog = undefined;
			},
			opts?.signal,
			{ blocked, stack: opts?.stack },
		);
		host.selectorDialog = new DialogSelectorComponent(title, options, finish, () => finish(undefined), {
			tui: host.ui,
			timeout: opts?.timeout,
			...(card ? { ask: card.view, ...(card.onWriteIn ? { onWriteIn: card.onWriteIn } : {}) } : {}),
			onToggleToolsExpanded: () => host.toggleToolOutputExpansion(),
			// A dialog that opens mid-run (an approval) keeps what the user types: it is submitted as if typed in the editor
			// (dialog unit tests build hosts without a session).
			onSubmitText: host.session?.isStreaming ? (text) => host.defaultEditor.onSubmit?.(text) : undefined,
		});
		lease.mount(host.selectorDialog);
	});
}

/**
 * Hide the feature selector.
 */
export function hideSelectorDialog(host: DialogsHost): void {
	if (getEditorSlot(host).cancelActive()) return;
	host.selectorDialog?.dispose();
	host.selectorDialog = undefined;
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
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
	return confirmInAsk(
		{
			ui: {
				custom: (factory, options) =>
					host.showCustomDialog(factory, { ...options, blocked: { kind: "question", message: title } } as never),
			},
		},
		title,
		message,
		opts,
	);
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

		const { lease, finish } = openDialog(
			host,
			resolve,
			() => {
				host.inputDialog?.dispose();
				host.inputDialog = undefined;
			},
			opts?.signal,
			{ blocked: { kind: "question", message: title } },
		);
		host.inputDialog = new DialogInputComponent(title, placeholder, finish, () => finish(undefined), {
			tui: host.ui,
			timeout: opts?.timeout,
		});
		lease.mount(host.inputDialog);
	});
}

/**
 * Hide the feature input.
 */
export function hideInputDialog(host: DialogsHost): void {
	if (getEditorSlot(host).cancelActive()) return;
	host.inputDialog?.dispose();
	host.inputDialog = undefined;
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
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

		const { lease, finish } = openDialog(
			host,
			resolve,
			() => {
				host.editorDialog = undefined;
			},
			opts?.signal,
			{ blocked: { kind: "question", message: title } },
		);
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
		lease.mount(host.editorDialog);
	});
}

/**
 * Hide the feature editor.
 */
export function hideEditorDialog(host: DialogsHost): void {
	if (getEditorSlot(host).cancelActive()) return;
	host.editorDialog = undefined;
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
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
		blocked?: BlockedStatus;
		stack?: boolean;
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
		let component: (Component & { dispose?(): void }) | undefined;
		let overlayHandle: OverlayHandle | undefined;
		let releaseOverlay: (() => void) | undefined;
		let lease: SlotLease | undefined;
		let closed = false;

		const disposeComponent = (c: (Component & { dispose?(): void }) | undefined) => {
			try {
				c?.dispose?.();
			} catch {
				/* ignore dispose errors */
			}
		};

		const close = (result: T | undefined) => {
			if (closed) return;
			closed = true;
			if (isOverlay) {
				releaseOverlay?.();
				overlayHandle?.hide();
				resolve(result);
				disposeComponent(component);
			} else {
				const target = component;
				component = undefined;
				lease?.release();
				resolve(result);
				disposeComponent(target);
			}
		};

		// Reserve the editor slot synchronously before an async factory runs so a newer dialog cannot be clobbered.
		if (!isOverlay) {
			lease = getEditorSlot(host).acquire({
				cancel: () => close(undefined),
				blocked: options?.blocked,
				stack: options?.stack,
				restoreEditor,
			});
		}

		Promise.resolve(factory(host.ui, theme, host.keybindings, close))
			.then((c) => {
				// `done` ran before the factory returned: `close` had no component to dispose, so dispose it here.
				if (closed) {
					disposeComponent(c);
					return;
				}
				component = c;
				if (isOverlay) {
					captureCommandDialog(host.ui, component);
					const resolveOptions = (): OverlayOptions | undefined => {
						if (options?.overlayOptions) {
							return typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
						}
						const w = (component as { width?: number }).width;
						return w ? { width: w } : undefined;
					};
					overlayHandle = host.ui.showOverlay(component, resolveOptions());
					const overlays = openOverlays.get(host) ?? new Set<() => void>();
					openOverlays.set(host, overlays);
					const cancel = () => close(undefined);
					overlays.add(cancel);
					releaseOverlay = () => overlays.delete(cancel);
					options?.onHandle?.(overlayHandle);
				} else {
					lease?.mount(component);
				}
			})
			.catch((err) => {
				if (closed) return;
				closed = true;
				if (!isOverlay) lease?.release();
				reject(err);
			});
	});
}
