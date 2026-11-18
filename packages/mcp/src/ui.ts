/**
 * The `/mcp` manager view: menus that rebuild while servers connect, a read-only status screen, and
 * the sign-in screen that accepts a pasted redirect URL.
 */

import {
	type Component,
	type Focusable,
	Input,
	type SelectItem,
	Spacer,
	Text,
	type TUI,
} from "@octocodeai/octocode-tui";
import type { McpCommandContext, McpKeybindings, McpTheme } from "./host/types.ts";
import { hostUi } from "./host.ts";

export interface McpMenuItem extends SelectItem {
	/** A short state word at the right edge. */
	badge?: string;
	tone?: "success" | "muted" | "warning" | "error";
}

export interface McpMenu {
	title: string;
	/** Heading of the list: `Servers`, `Actions`. */
	heading?: string;
	/** Fact rows under the title (a detail page). */
	facts?: Array<{ label: string; value: string }>;
	/** Shown below the list, muted. */
	details?: string;
	/** Shown below the list in the error color. */
	error?: string;
	items: McpMenuItem[];
	/** Shown when there are no items. */
	empty?: string;
	/** Value of the item selected when the menu opens. */
	selected?: string;
	/** What the confirm key does, for the key hint. */
	confirmLabel: string;
	/** What the cancel key does, for the key hint. */
	cancelLabel: string;
	/** Single keys that act on the highlighted item without closing the menu. */
	keys?: ReadonlyArray<{ key: string; label: string }>;
	onKey?(key: string, value: string): void;
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
	/** Edit one literal field. Undefined cancels; an empty string is a submitted value. */
	input?(title: string, value: string, hint: string): Promise<string | undefined>;
}

/** The key hints of a one-field form: Enter submits, Escape cancels, joined like every page footer. */
const formHints = (): string =>
	`${hostUi().keyHint("tui.select.confirm", "submit")} · ${hostUi().keyHint("tui.select.cancel", "cancel")}`;

export class McpManagerView implements McpUi, Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: McpTheme;
	private readonly keybindings: McpKeybindings;
	private content: Component;
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

	private setContent(content: Component, inputHandler?: (data: string) => void, inputTarget?: Focusable): void {
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
				const page = hostUi().page({
					title: menu.title,
					facts: menu.facts,
					alerts: menu.error ? menu.error.split("\n") : undefined,
					notes: menu.details ? menu.details.split("\n") : undefined,
					heading: menu.heading ?? "Items",
					rows: menu.items.map((item) => ({
						id: item.value,
						name: item.label,
						detail: item.description,
						badge: item.badge,
						tone: item.tone,
					})),
					empty: menu.empty ?? "Nothing to show.",
					initialId: wanted,
					confirmLabel: menu.confirmLabel,
					cancelLabel: menu.cancelLabel,
					keys: menu.keys,
					onKey: menu.onKey,
					onSelect: (id) => finish(id),
					onHighlight: (id) => {
						selected = id;
					},
					onCancel: () => finish(undefined),
				});
				selected = menu.items.some((item) => item.value === wanted) ? wanted : menu.items[0]?.value;
				this.setContent(page, (data) => page.handleInput?.(data));
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
				hostUi().frame(this.theme, title, body, formHints()),
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

	input(title: string, value: string, hint: string): Promise<string | undefined> {
		if (this.disposed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const input = new Input();
			input.setValue(value);
			const finish = (answer: string | undefined) => {
				this.pending.delete(cancel);
				resolve(answer);
			};
			const cancel = () => finish(undefined);
			this.pending.add(cancel);
			this.setContent(
				hostUi().frame(this.theme, title, [new Text(hint, 1, 1), input], formHints()),
				(data) => {
					if (this.keybindings.matches(data, "tui.select.confirm")) finish(input.getValue());
					else if (this.keybindings.matches(data, "tui.select.cancel")) cancel();
					else input.handleInput(data);
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
