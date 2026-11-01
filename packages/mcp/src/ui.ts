/**
 * The `/mcp` manager view: menus that rebuild while servers connect, a read-only status screen, and
 * the sign-in screen that accepts a pasted redirect URL.
 */

import {
	type Component,
	type Container,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@octocodeai/octocode-tui";
import type { McpCommandContext, McpKeybindings, McpTheme } from "./host/types.ts";
import { hostUi } from "./host.ts";

export interface McpMenu {
	title: string;
	/** Shown below the title. */
	details?: string;
	/** Shown below the details in the error color. */
	error?: string;
	items: SelectItem[];
	/** Shown when there are no items. */
	empty?: string;
	/** Value of the item selected when the menu opens. */
	selected?: string;
	/** What the confirm key does, for the key hint. */
	confirmLabel: string;
	/** What the cancel key does, for the key hint. */
	cancelLabel: string;
}

/** After the view is disposed, menus and the sign-in prompt resolve as cancelled and a cancellable status cancels. */
export interface McpUi {
	/**
	 * Show a menu and resolve to the chosen item's value, or undefined when cancelled. `subscribe`
	 * rebuilds the menu on every change, keeping the selected item.
	 */
	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined>;
	/** Show a message while an operation runs. With `onCancel`, the cancel key calls it. */
	status(title: string, message: string, onCancel?: () => void): void;
	/**
	 * Show the authorization URL and wait for a pasted redirect URL. Resolves to undefined when
	 * cancelled or when `signal` aborts (the browser reached the callback).
	 */
	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined>;
}

const MAX_VISIBLE_ITEMS = 12;

export class McpManagerView implements McpUi, Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: McpTheme;
	private readonly keybindings: McpKeybindings;
	private content: Container;
	private inputHandler: ((data: string) => void) | undefined;
	private inputTarget: Focusable | undefined;
	private _focused = false;
	private disposed = false;
	/** Settle the open menu or sign-in prompt as cancelled. */
	private readonly pending = new Set<() => void>();
	/** The cancel key's action on the status screen shown now. */
	private statusCancel: (() => void) | undefined;

	constructor(tui: TUI, theme: McpTheme, keybindings: McpKeybindings) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.content = hostUi().frame(theme, "MCP servers", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	private setContent(content: Container, inputHandler?: (data: string) => void, inputTarget?: Focusable): void {
		if (this.disposed) return;
		if (this.inputTarget) this.inputTarget.focused = false;
		this.statusCancel = undefined;
		this.content = content;
		this.inputHandler = inputHandler;
		this.inputTarget = inputTarget;
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		this.tui.requestRender();
	}

	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined> {
		if (this.disposed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				this.pending.delete(cancel);
				unsubscribe?.();
				resolve(value);
			};
			const cancel = () => finish(undefined);
			let selected: string | undefined;
			const render = () => {
				const menu = build();
				const wanted = selected ?? menu.selected;
				const body: Component[] = [];
				if (menu.details) body.push(new Text(this.theme.fg("muted", menu.details), 1, 0));
				if (menu.error) body.push(new Text(this.theme.fg("error", menu.error), 1, 0));
				body.push(new Spacer(1));
				const footer = `${hostUi().keyHint("tui.select.confirm", menu.confirmLabel)} • ${hostUi().keyHint("tui.select.cancel", menu.cancelLabel)}`;
				if (menu.items.length === 0) {
					body.push(new Text(this.theme.fg("muted", menu.empty ?? "Nothing to show."), 1, 0));
					this.setContent(
						hostUi().frame(this.theme, menu.title, body, hostUi().keyHint("tui.select.cancel", menu.cancelLabel)),
						(data) => {
							if (this.keybindings.matches(data, "tui.select.cancel")) finish(undefined);
						},
					);
					return;
				}
				const list = new SelectList(
					menu.items,
					Math.min(menu.items.length, MAX_VISIBLE_ITEMS),
					hostUi().selectListTheme(),
				);
				const index = menu.items.findIndex((item) => item.value === wanted);
				if (index !== -1) list.setSelectedIndex(index);
				selected = list.getSelectedItem()?.value;
				list.onSelectionChange = (item) => {
					selected = item.value;
				};
				list.onSelect = (item) => finish(item.value);
				list.onCancel = () => finish(undefined);
				body.push(list);
				this.setContent(hostUi().frame(this.theme, menu.title, body, footer), (data) => list.handleInput(data));
			};
			render();
			// Input handlers and `dispose` call `finish` only after this assignment.
			const unsubscribe = subscribe?.(() => {
				if (!settled) render();
			});
			this.pending.add(cancel);
		});
	}

	status(title: string, message: string, onCancel?: () => void): void {
		if (this.disposed) {
			onCancel?.();
			return;
		}
		const body = [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)];
		if (!onCancel) {
			this.setContent(hostUi().frame(this.theme, title, body));
			return;
		}
		this.setContent(
			hostUi().frame(this.theme, title, body, hostUi().keyHint("tui.select.cancel", "cancel")),
			(data) => {
				if (this.keybindings.matches(data, "tui.select.cancel")) onCancel();
			},
		);
		this.statusCancel = onCancel;
	}

	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined> {
		if (this.disposed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				this.pending.delete(onAbort);
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish(undefined);
			if (signal.aborted) {
				finish(undefined);
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			this.pending.add(onAbort);
			const input = new Input();
			const link = hostUi().authUrl(this.tui, authorizationUrl);
			const body: Component[] = [
				new Spacer(1),
				new Text(this.theme.fg("muted", "Approve access in your browser. If it did not open, visit:"), 1, 0),
				link,
				new Spacer(1),
				new Text(
					this.theme.fg("muted", "If the browser runs on another machine, paste the URL it was redirected to:"),
					1,
					0,
				),
				input,
			];
			this.setContent(
				hostUi().frame(
					this.theme,
					title,
					body,
					`${hostUi().keyHint("tui.select.confirm", "submit")} • ${hostUi().keyHint("tui.select.cancel", "cancel")}`,
				),
				(data) => {
					if (this.keybindings.matches(data, "tui.select.confirm")) {
						const value = input.getValue().trim();
						if (value) finish(value);
						return;
					}
					if (this.keybindings.matches(data, "tui.select.cancel")) {
						finish(undefined);
						return;
					}
					if (this.keybindings.matches(data, "app.message.copy")) {
						void link.copy();
						return;
					}
					input.handleInput(data);
				},
				input,
			);
		});
	}

	handleInput(data: string): void {
		this.inputHandler?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return hostUi().renderClipped(this.content, width);
	}

	invalidate(): void {
		this.content.invalidate();
	}

	/**
	 * Something else took the view's place (`runInView`): settle the open menu or sign-in prompt as cancelled, which
	 * unsubscribes the menu, and cancel a cancellable operation, so the manager's run ends through its cancel paths.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const cancels = [...this.pending, ...(this.statusCancel ? [this.statusCancel] : [])];
		this.pending.clear();
		this.statusCancel = undefined;
		this.inputHandler = undefined;
		for (const cancel of cancels) cancel();
	}
}

/** Run `manage` in the manager view until it returns. */
export async function showMcpManager(ctx: McpCommandContext, manage: (ui: McpUi) => Promise<void>): Promise<void> {
	await hostUi().runInView<McpManagerView>(
		ctx,
		(tui, theme, keybindings) => new McpManagerView(tui, theme, keybindings),
		manage,
	);
}
