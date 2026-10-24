/**
 * Dialogs extensions open in place of the editor: selectors, confirmations, text input, the multi-line editor and
 * custom components, plus the missing-cwd prompt that uses the same selector.
 */

import type { OverlayHandle, OverlayOptions, Component, TUI } from "@octocodeai/octocode-tui";
import type { ExtensionUIDialogOptions } from "../../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../../../core/session-cwd.ts";
import { ExtensionEditorComponent } from "../components/extension-editor.ts";
import { ExtensionInputComponent } from "../components/extension-input.ts";
import { ExtensionSelectorComponent } from "../components/extension-selector.ts";
import type { BlockedStatus } from "../program-status-reporter.ts";
import { type Theme, theme } from "../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the extension dialogs. */
type ExtensionDialogsHost = Pick<
	InteractiveModeHost,
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
	| "settingsManager"
	| "showExtensionConfirm"
	| "showExtensionSelector"
	| "toggleToolOutputExpansion"
	| "ui"
>;

/**
 * Show a selector for extensions.
 */
export function showExtensionSelector(
	host: ExtensionDialogsHost,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
	blocked: BlockedStatus = { kind: "question", message: title },
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const onAbort = () => {
			host.hideExtensionSelector();
			resolve(undefined);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		host.extensionSelector = new ExtensionSelectorComponent(
			title,
			options,
			(option) => {
				opts?.signal?.removeEventListener("abort", onAbort);
				host.hideExtensionSelector();
				resolve(option);
			},
			() => {
				opts?.signal?.removeEventListener("abort", onAbort);
				host.hideExtensionSelector();
				resolve(undefined);
			},
			{ tui: host.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => host.toggleToolOutputExpansion() },
		);

		host.disposeActiveSelector();
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
	const result = await host.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts, {
		kind: "permission",
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

		const onAbort = () => {
			host.hideExtensionInput();
			resolve(undefined);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		host.extensionInput = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => {
				opts?.signal?.removeEventListener("abort", onAbort);
				host.hideExtensionInput();
				resolve(value);
			},
			() => {
				opts?.signal?.removeEventListener("abort", onAbort);
				host.hideExtensionInput();
				resolve(undefined);
			},
			{ tui: host.ui, timeout: opts?.timeout },
		);

		host.disposeActiveSelector();
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
): Promise<string | undefined> {
	return new Promise((resolve) => {
		host.extensionEditor = new ExtensionEditorComponent(
			host.ui,
			host.keybindings,
			title,
			prefill,
			(value) => {
				host.hideExtensionEditor();
				resolve(value);
			},
			() => {
				host.hideExtensionEditor();
				resolve(undefined);
			},
			undefined,
			host.settingsManager.getExternalEditorCommand(),
		);

		host.disposeActiveSelector();
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
	host.editorContainer.clear();
	host.editorContainer.addChild(host.editor);
	host.extensionEditor = undefined;
	host.programStatus.setBlocked("extension-dialog", undefined);
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
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
): Promise<T> {
	const savedText = host.editor.getText();
	const isOverlay = options?.overlay ?? false;

	const restoreEditor = () => {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.editor.setText(savedText);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	return new Promise((resolve, reject) => {
		let component: Component & { dispose?(): void };
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;

		const close = (result: T) => {
			if (closed) return;
			closed = true;
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
				if (closed) return;
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
					// Expose handle to caller for visibility control
					options?.onHandle?.(overlayHandle);
				} else {
					host.disposeActiveSelector();
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
