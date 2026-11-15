/**
 * Dialogs extensions open in place of the editor: selectors, confirmations, text input, the multi-line editor and
 * custom components, plus the missing-cwd prompt that uses the same selector.
 */

import type { OverlayHandle, OverlayOptions, Component, TUI } from "@octocodeai/octocode-tui";
import type { ExtensionUIDialogOptions } from "../../../core/features/index.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../../../core/session-cwd.ts";
import { ExtensionEditorComponent } from "../components/extension-editor.ts";
import { ExtensionInputComponent } from "../components/extension-input.ts";
import { ExtensionSelectorComponent } from "../components/extension-selector.ts";
import type { BlockedStatus } from "../program-status-reporter.ts";
import { type Theme, theme } from "../../../theme/theme.ts";
import type { InteractiveModeHost, SelectorCard } from "./host.ts";

/** Interactive-mode members used by the extension dialogs. */
type ExtensionDialogsHost = Pick<
	InteractiveModeHost,
	| "activeSelectorDispose"
	| "defaultEditor"
	| "disposeActiveSelector"
	| "editor"
	| "editorContainer"
	| "extensionEditor"
	| "extensionInput"
	| "extensionSelector"
	| "hideExtensionEditor"
	| "hideExtensionInput"
	| "hideExtensionSelector"
	| "keybindings"
	| "programStatus"
	| "session"
	| "settingsManager"
	| "showExtensionConfirm"
	| "showExtensionSelector"
	| "toggleToolOutputExpansion"
	| "ui"
	| "uiStore"
>;

/**
 * The open dialog's cancel, per host. Selectors, inputs and the editor share the editor slot, so one is open at a time:
 * opening another or hiding it from outside (`resetExtensionUI` on reload or session replacement) answers it with no
 * value, instead of leaving its caller and the dialog queue (`withDialog`) waiting for an answer nobody can give.
 */
const openDialogs = new WeakMap<object, () => void>();

/** Each host's open custom overlays, closed (answered with no value) by `closeExtensionOverlays`. */
const openOverlays = new WeakMap<object, Set<() => void>>();

function takeOpenDialog(host: object): (() => void) | undefined {
	const cancel = openDialogs.get(host);
	openDialogs.delete(host);
	return cancel;
}

type SlotHost = Pick<ExtensionDialogsHost, "activeSelectorDispose" | "disposeActiveSelector" | "uiStore">;

/**
 * Take the editor slot for a dialog or a non-overlay custom component. Whatever holds it (an extension dialog, a
 * built-in selector or another custom component) is answered or disposed first, and `cancel` becomes the slot's
 * dispose, so whatever takes the slot next through `disposeActiveSelector` (a dialog, `showSelector`, a custom component,
 * a custom editor, the reset on reload or session replacement, or stop) answers this one with no value. Returns the
 * release to call when it closes by itself.
 */
function takeSlot(host: SlotHost, cancel: () => void): () => void {
	takeOpenDialog(host)?.();
	host.disposeActiveSelector();
	const token = {};
	host.uiStore.getState().takeSlot(token);
	host.activeSelectorDispose = cancel;
	return () => {
		if (!host.uiStore.getState().releaseSlot(token)) return;
		host.activeSelectorDispose = undefined;
	};
}

/**
 * Answer the open dialog, then register a new one in the editor slot; the result settles it once, releases the slot,
 * hides it and stops listening to `signal`.
 */
function openDialog<T>(
	host: SlotHost,
	resolve: (value: T | undefined) => void,
	hide: () => void,
	signal: AbortSignal | undefined,
): (value: T | undefined) => void {
	let done = false;
	const finish = (value: T | undefined) => {
		if (done) return;
		done = true;
		signal?.removeEventListener("abort", cancel);
		if (openDialogs.get(host) === cancel) openDialogs.delete(host);
		release();
		hide();
		resolve(value);
	};
	const cancel = () => finish(undefined);
	const release = takeSlot(host, cancel);
	signal?.addEventListener("abort", cancel, { once: true });
	openDialogs.set(host, cancel);
	return finish;
}

/**
 * Answer every custom overlay open on `host` with no value, as the reset on reload or session replacement does, and
 * report whether there was one.
 */
export function closeExtensionOverlays(host: object): boolean {
	const closes = [...(openOverlays.get(host) ?? [])];
	for (const close of closes) close();
	return closes.length > 0;
}

/**
 * Show a selector for extensions. `blocked` is what the footer reports while it is open (a question unless the caller
 * says otherwise); `card` draws it as an ask card (`extension-ask.ts` shows approvals this way).
 */
export function showExtensionSelector(
	host: ExtensionDialogsHost,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
	blocked: BlockedStatus = { kind: "question", message: title },
	card?: SelectorCard,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = openDialog(host, resolve, () => host.hideExtensionSelector(), opts?.signal);
		host.extensionSelector = new ExtensionSelectorComponent(title, options, finish, () => finish(undefined), {
			tui: host.ui,
			timeout: opts?.timeout,
			...(card ? { ask: card.view, ...(card.onWriteIn ? { onWriteIn: card.onWriteIn } : {}) } : {}),
			onToggleToolsExpanded: () => host.toggleToolOutputExpansion(),
			// A dialog that opens mid-run (an approval) keeps what the user types: it is submitted as if typed in the editor
			// (dialog unit tests build hosts without a session).
			onSubmitText: host.session?.isStreaming ? (text) => host.defaultEditor.onSubmit?.(text) : undefined,
		});

		host.editorContainer.clear();
		host.editorContainer.addChild(host.extensionSelector);
		host.ui.setFocus(host.extensionSelector);
		// Extension dialogs share the editor slot: opening one replaces the status of a displaced one.
		host.programStatus.setBlocked("extension-dialog", blocked);
		host.ui.requestRender();
	});
}

/**
 * Hide the extension selector.
 */
export function hideExtensionSelector(host: ExtensionDialogsHost): void {
	const cancel = takeOpenDialog(host);
	if (cancel) return cancel();
	host.extensionSelector?.dispose();
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
	host.extensionSelector = undefined;
	host.programStatus.setBlocked("extension-dialog", undefined);
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

/**
 * Show a confirmation dialog for extensions.
 */
export async function showExtensionConfirm(
	host: ExtensionDialogsHost,
	title: string,
	message: string,
	opts?: ExtensionUIDialogOptions,
): Promise<boolean> {
	const result = await host.showExtensionSelector(`${title}\n${message}`, ["No", "Yes"], opts, {
		kind: "question",
		message: title,
	});
	return result === "Yes";
}

export async function promptForMissingSessionCwd(
	host: ExtensionDialogsHost,
	error: MissingSessionCwdError,
): Promise<string | undefined> {
	const confirmed = await host.showExtensionConfirm(
		"Session cwd not found",
		formatMissingSessionCwdPrompt(error.issue),
	);
	return confirmed ? error.issue.fallbackCwd : undefined;
}

/**
 * Show a text input for extensions.
 */
export function showExtensionInput(
	host: ExtensionDialogsHost,
	title: string,
	placeholder?: string,
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = openDialog(host, resolve, () => host.hideExtensionInput(), opts?.signal);
		host.extensionInput = new ExtensionInputComponent(title, placeholder, finish, () => finish(undefined), {
			tui: host.ui,
			timeout: opts?.timeout,
		});

		host.editorContainer.clear();
		host.editorContainer.addChild(host.extensionInput);
		host.ui.setFocus(host.extensionInput);
		host.programStatus.setBlocked("extension-dialog", { kind: "question", message: title });
		host.ui.requestRender();
	});
}

/**
 * Hide the extension input.
 */
export function hideExtensionInput(host: ExtensionDialogsHost): void {
	const cancel = takeOpenDialog(host);
	if (cancel) return cancel();
	host.extensionInput?.dispose();
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
	host.extensionInput = undefined;
	host.programStatus.setBlocked("extension-dialog", undefined);
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

/**
 * Show a multi-line editor for extensions (with Ctrl+G support).
 */
export function showExtensionEditor(
	host: ExtensionDialogsHost,
	title: string,
	prefill?: string,
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = openDialog(host, resolve, () => host.hideExtensionEditor(), opts?.signal);
		host.extensionEditor = new ExtensionEditorComponent(
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
		host.editorContainer.addChild(host.extensionEditor);
		host.ui.setFocus(host.extensionEditor);
		host.programStatus.setBlocked("extension-dialog", { kind: "question", message: title });
		host.ui.requestRender();
	});
}

/**
 * Hide the extension editor.
 */
export function hideExtensionEditor(host: ExtensionDialogsHost): void {
	const cancel = takeOpenDialog(host);
	if (cancel) return cancel();
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
	host.extensionEditor = undefined;
	host.programStatus.setBlocked("extension-dialog", undefined);
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

/**
 * Show a custom component with keyboard focus. Overlay mode renders on top of existing content; otherwise the
 * component takes the editor slot. It resolves with the component's result, or undefined when something else takes its
 * slot or the reset closes it; either way it is disposed once.
 */
export async function showExtensionCustom<T>(
	host: ExtensionDialogsHost,
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
