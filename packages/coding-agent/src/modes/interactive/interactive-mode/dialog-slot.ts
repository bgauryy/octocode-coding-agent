/**
 * Single state machine owning the interactive editor slot (`host.editorContainer`).
 *
 * Selectors (`showSelector`), feature dialogs (`showSelectorDialog`, `showInputDialog`, `showEditorDialog`,
 * `showConfirmDialog`), and non-overlay custom components (`showCustomDialog`) all acquire leases here.
 * Supports synchronous token reservation (eliminating async clobber races), token-scoped terminal blocked status,
 * and a 1-level sub-prompt stack (`stack: true`) so cancelling a child prompt restores the suspended parent in place.
 */

import type { Component } from "@octocodeai/octocode-tui";
import type { BlockedStatus } from "../program-status-reporter.ts";
import type { InteractiveModeHost } from "./host.ts";
import { captureCommandDialog } from "./web-command-context.ts";

export type SlotHost = Pick<
	InteractiveModeHost,
	| "activeSelectorDispose"
	| "activeStatusIndicator"
	| "clearStatusIndicator"
	| "disposeActiveSelector"
	| "editor"
	| "editorContainer"
	| "programStatus"
	| "session"
	| "ui"
	| "uiStore"
>;

interface SlotEntry {
	readonly token: object;
	component?: Component;
	focus?: Component;
	blocked?: BlockedStatus;
	readonly cancel: () => void;
	dispose?: () => void;
	readonly restoreEditor?: () => void;
}

export interface SlotAcquireOptions {
	cancel: () => void;
	blocked?: BlockedStatus;
	/** Suspend the current slot holder instead of disposing it; restored automatically when this lease releases. */
	stack?: boolean;
	/** Custom editor-restore callback when returning to the chat editor (e.g. preserving draft edits). */
	restoreEditor?: () => void;
}

export interface SlotLease {
	readonly token: object;
	isCurrent(): boolean;
	mount(component: Component, focus?: Component, dispose?: () => void): boolean;
	setDispose(dispose: (() => void) | undefined): void;
	setBlocked(blocked: BlockedStatus | undefined): void;
	release(): boolean;
}

export class EditorSlot {
	private readonly host: SlotHost;
	private active?: SlotEntry;
	private suspended?: SlotEntry;

	constructor(host: SlotHost) {
		this.host = host;
	}

	/** Reserve the editor slot synchronously; displaces any prior holder unless `stack: true`. */
	acquire(options: SlotAcquireOptions): SlotLease {
		if (options.stack && this.active && !this.suspended) {
			this.suspended = this.active;
			this.active = undefined;
		} else {
			this.teardownAll(false);
		}

		// Enter shows "Working" before a command runs; a page that opens with no run behind it is not working.
		if (this.host.activeStatusIndicator?.kind === "working" && !this.host.session?.isStreaming) {
			this.host.clearStatusIndicator("working");
		}

		const entry: SlotEntry = {
			token: {},
			cancel: options.cancel,
			blocked: options.blocked,
			restoreEditor: options.restoreEditor,
		};
		this.active = entry;
		this.host.uiStore.getState().takeSlot(entry.token);
		this.host.activeSelectorDispose = () => this.disposeAll();
		if (entry.blocked !== undefined) {
			this.host.programStatus?.setBlocked("feature-dialog", entry.blocked);
		}

		return {
			token: entry.token,
			isCurrent: () => this.active === entry,
			mount: (component, focus, dispose) => {
				if (this.active !== entry) return false;
				const targetFocus = focus ?? component;
				entry.component = component;
				entry.focus = targetFocus;
				if (dispose !== undefined) entry.dispose = dispose;
				this.host.editorContainer.clear();
				this.host.editorContainer.addChild(component);
				this.host.ui.setFocus(targetFocus);
				captureCommandDialog(this.host.ui, component, targetFocus);
				this.host.ui.requestRender();
				return true;
			},
			setDispose: (dispose) => {
				if (this.active === entry) entry.dispose = dispose;
			},
			setBlocked: (blocked) => {
				if (this.active !== entry) return;
				entry.blocked = blocked;
				this.host.programStatus?.setBlocked("feature-dialog", blocked);
			},
			release: () => this.releaseEntry(entry),
		};
	}

	/** Cancel only the active slot holder (restoring a suspended parent if one is stacked). */
	cancelActive(): boolean {
		const current = this.active;
		if (!current) return false;
		current.cancel();
		return true;
	}

	/** Cancel and dispose both the active holder and any suspended parent, then restore the chat editor. */
	disposeAll(): void {
		this.teardownAll(true);
	}

	private teardownAll(restoreEditor: boolean): void {
		const active = this.active;
		const suspended = this.suspended;
		this.active = undefined;
		this.suspended = undefined;
		const externalDispose = !active && !suspended ? this.host.activeSelectorDispose : undefined;
		this.host.activeSelectorDispose = undefined;
		this.host.uiStore.getState().clearSlot();
		this.host.programStatus?.setBlocked("feature-dialog", undefined);

		const teardown = (entry: SlotEntry | undefined) => {
			if (!entry) return;
			try {
				entry.cancel();
			} finally {
				const dispose = entry.dispose;
				entry.dispose = undefined;
				dispose?.();
			}
		};
		teardown(active);
		teardown(suspended);
		externalDispose?.();

		if (restoreEditor && (active || suspended)) {
			const restore = active?.restoreEditor ?? suspended?.restoreEditor;
			if (restore) {
				restore();
			} else {
				this.host.editorContainer.clear();
				this.host.editorContainer.addChild(this.host.editor);
				this.host.ui.setFocus(this.host.editor);
				this.host.ui.requestRender();
			}
		}
	}

	private releaseEntry(entry: SlotEntry): boolean {
		if (this.active !== entry) return false;
		this.active = undefined;
		const dispose = entry.dispose;
		entry.dispose = undefined;
		try {
			dispose?.();
		} catch {
			/* ignore dispose errors */
		}

		if (this.suspended) {
			const parent = this.suspended;
			this.suspended = undefined;
			this.active = parent;
			this.host.activeSelectorDispose = () => this.disposeAll();
			this.host.uiStore.getState().takeSlot(parent.token);
			this.host.programStatus?.setBlocked("feature-dialog", parent.blocked);
			if (parent.component) {
				this.host.editorContainer.clear();
				this.host.editorContainer.addChild(parent.component);
				this.host.ui.setFocus(parent.focus ?? parent.component);
				this.host.ui.requestRender();
			}
			return true;
		}

		this.host.uiStore.getState().releaseSlot(entry.token);
		this.host.activeSelectorDispose = undefined;
		this.host.programStatus?.setBlocked("feature-dialog", undefined);
		if (entry.restoreEditor) {
			entry.restoreEditor();
		} else {
			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this.host.editor);
			this.host.ui.setFocus(this.host.editor);
			this.host.ui.requestRender();
		}
		return true;
	}
}

const editorSlots = new WeakMap<object, EditorSlot>();

/** Returns the single `EditorSlot` state machine for `host`. */
export function getEditorSlot(host: SlotHost): EditorSlot {
	let slot = editorSlots.get(host);
	if (!slot) {
		slot = new EditorSlot(host);
		editorSlots.set(host, slot);
	}
	return slot;
}

/**
 * Open a promise-backed dialog in the editor slot; returns `{ lease, finish }` where `finish(value)` settles once,
 * releases the slot (restoring any suspended parent or the chat editor), and unsubscribes from `signal`.
 */
export function openDialog<T>(
	host: SlotHost,
	resolve: (value: T | undefined) => void,
	onCleanup: () => void,
	signal: AbortSignal | undefined,
	options: { blocked?: BlockedStatus; stack?: boolean } = {},
): { lease: SlotLease; finish: (value: T | undefined) => void } {
	let done = false;
	const cancel = () => finish(undefined);
	const lease = getEditorSlot(host).acquire({
		cancel,
		blocked: options.blocked,
		stack: options.stack,
	});
	const finish = (value: T | undefined) => {
		if (done) return;
		done = true;
		signal?.removeEventListener("abort", cancel);
		onCleanup();
		lease.release();
		resolve(value);
	};
	signal?.addEventListener("abort", cancel, { once: true });
	return { lease, finish };
}
