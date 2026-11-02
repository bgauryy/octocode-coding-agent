import {
	type Component,
	type Focusable,
	Input,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { EMPTY_INVENTORY, HOST_TITLES, type InventoryItem } from "../../core/extensibility/inventory.ts";
import { blockedReason, type SwitchScope } from "../../core/extensibility/switch.ts";
import type { Theme } from "../../theme/theme.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { shortcutText } from "../shared/keys.ts";

type Row = { type: "host"; title: string } | { type: "item"; item: InventoryItem };

export interface PickerOptions {
	items: InventoryItem[];
	/** Switches one item; returns the confirmation, throws a user-facing reason. */
	apply: (item: InventoryItem, on: boolean, scope: SwitchScope, force: boolean) => string;
	/** Where each scope writes, shown under the title. */
	paths: Record<SwitchScope, string>;
	height: number;
	/** Counts the list cannot show as rows (stale or ignored switches, diagnostics); `/harness list` prints them. */
	summary?: string;
	done: (changed: boolean) => void;
	requestRender: () => void;
}

/**
 * `/harness` in the terminal, with the keys and layout of `octocode config`: type to filter, ↑↓ PgUp/PgDn move between
 * items (headings are skipped), Space or Enter switches, Tab picks global or project scope, Esc closes. The selected
 * row's full detail sits under the list, and a gate hook needs a second press before it switches off.
 */
export class HarnessPicker implements Component, Focusable {
	private readonly search = new Input({ placeholder: "type to filter" });
	private rows: Row[] = [];
	private selected = 0;
	private scope: SwitchScope = "global";
	private changed = false;
	private flash: { text: string; level: "success" | "warning" } | undefined;
	private armedGate: string | undefined;
	private _focused = false;
	/** Hook files whose hooks are listed; files start collapsed so a long hook list stays one screen. */
	private readonly expanded = new Set<string>();
	private readonly options: PickerOptions;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;

	constructor(options: PickerOptions, theme: Theme, keys: KeybindingsManager) {
		this.options = options;
		this.theme = theme;
		this.keys = keys;
		this.filter();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	private get maxVisible(): number {
		// Title, scope, search, blank, detail (2), flash, hints, two borders.
		return Math.max(5, this.options.height - 10);
	}

	/** Rebuild the rows; keeps the selection on `keep` when it is still listed. */
	private filter(keep?: string): void {
		const query = this.search.getValue().trim().toLowerCase();
		// A filter lists every match; otherwise a hook shows only under an expanded file.
		const visible = (item: InventoryItem) =>
			query
				? [item.label, item.id, item.detail].some((text) => text.toLowerCase().includes(query))
				: item.kind !== "hook" || this.expanded.has(item.parents?.[0] ?? "");
		this.rows = [];
		for (const host of Object.keys(HOST_TITLES) as InventoryItem["host"][]) {
			const items = this.options.items.filter((item) => item.host === host && visible(item));
			if (items.length)
				this.rows.push(
					{ type: "host", title: HOST_TITLES[host] },
					...items.map((item) => ({ type: "item" as const, item })),
				);
		}
		const kept = this.rows.findIndex((row) => row.type === "item" && row.item.id === keep);
		this.selected =
			kept >= 0
				? kept
				: Math.max(
						0,
						this.rows.findIndex((row) => row.type === "item"),
					);
	}

	/** → opens a hook file, ← closes it (from one of its hooks too). */
	private fold(item: InventoryItem, open: boolean): void {
		const file = item.kind === "hook" ? item.parents?.[0] : item.kind === "hook-file" ? item.id : undefined;
		if (!file) return;
		if (open) this.expanded.add(file);
		else this.expanded.delete(file);
		this.filter(open ? item.id : file);
	}

	private step(from: number, direction: 1 | -1, distance = 1): number {
		let index = Math.min(this.rows.length - 1, Math.max(0, from + direction * distance));
		while (index >= 0 && index < this.rows.length && this.rows[index].type !== "item") index += direction;
		return index >= 0 && index < this.rows.length ? index : from;
	}

	private toggle(item: InventoryItem): void {
		const reason = blockedReason(item, this.scope);
		if (reason) {
			this.flash = { text: `${item.label}: ${reason}`, level: "warning" };
			return;
		}
		const on = !item.on;
		const force = this.armedGate === item.id;
		if (!on && item.gate && !force) {
			this.armedGate = item.id;
			this.flash = {
				text: "This hook denies tool calls when it fails. Press again to switch it off.",
				level: "warning",
			};
			return;
		}
		this.armedGate = undefined;
		try {
			this.flash = { text: this.options.apply(item, on, this.scope, force), level: "success" };
			item.on = on;
			this.changed = true;
		} catch (error) {
			this.flash = { text: errorMessage(error), level: "warning" };
		}
	}

	handleInput(data: string): void {
		const row = this.rows[this.selected];
		if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
			this.options.done(this.changed);
			return;
		}
		if (this.keys.matches(data, "tui.select.up")) this.selected = this.step(this.selected, -1);
		else if (this.keys.matches(data, "tui.select.down")) this.selected = this.step(this.selected, 1);
		else if (this.keys.matches(data, "tui.select.pageUp"))
			this.selected = this.step(this.selected, -1, this.maxVisible);
		else if (this.keys.matches(data, "tui.select.pageDown"))
			this.selected = this.step(this.selected, 1, this.maxVisible);
		else if (matchesKey(data, "right") || matchesKey(data, "left")) {
			if (row?.type === "item" && !this.search.getValue().trim()) this.fold(row.item, matchesKey(data, "right"));
		} else if (this.keys.matches(data, "tui.input.tab")) {
			this.scope = this.scope === "global" ? "project" : "global";
			this.flash = undefined;
		} else if (data === " " || this.keys.matches(data, "tui.select.confirm")) {
			if (row?.type === "item") this.toggle(row.item);
		} else {
			this.search.handleInput(data);
			this.filter();
			this.flash = undefined;
		}
		this.options.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.max(20, width);
		const lines: string[] = [];
		const push = (text: string) => lines.push(truncateToWidth(text, w, "…"));
		const sep = t.fg("muted", " · ");
		// The key in dim, its action in muted: the same hint style as `octocode config` and the backlog board.
		const hint = (key: string, action: string) => `${t.fg("dim", key)}${t.fg("muted", ` ${action}`)}`;
		const title = t.bold(this.scope === "project" ? "Harness · Project" : "Harness · Global");
		const hints = [
			hint(shortcutText("tui.input.tab", this.keys), "scope"),
			hint("space/enter", "toggle"),
			hint("→/←", "hooks"),
			hint(shortcutText("tui.select.cancel", this.keys), "close"),
		].join(sep);
		push(t.fg("accent", "─".repeat(w)));
		push(`${title}${" ".repeat(Math.max(1, w - visibleWidth(title) - visibleWidth(hints)))}${hints}`);
		push(
			t.fg(
				"muted",
				`Writes ${this.options.paths[this.scope]}${this.scope === "project" ? " · only items from this repository" : ""}`,
			),
		);
		lines.push(...this.search.render(w), "");
		const items = this.rows.filter((row) => row.type === "item").length;
		if (!items)
			push(t.fg("muted", this.options.items.length ? "  Nothing matches the filter." : `  ${EMPTY_INVENTORY}`));
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(this.maxVisible / 2), this.rows.length - this.maxVisible),
		);
		const end = Math.min(this.rows.length, start + this.maxVisible);
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			if (row.type === "host") {
				push(`  ${t.fg("accent", t.bold(row.title))}`);
				continue;
			}
			const { item } = row;
			const selected = index === this.selected;
			const blocked = blockedReason(item, this.scope) !== undefined;
			const box = item.locked ? t.fg("warning", "[-]") : item.on ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
			const label = sanitizeTerminalText(item.label);
			const name = blocked ? t.fg("dim", label) : selected ? t.bold(label) : label;
			const brief = item.kind === "hook" ? (item.gate ? "gate" : "") : item.detail.split(" · ")[0];
			const summary = brief ? t.fg("dim", `  ${sanitizeTerminalText(brief)}`) : "";
			const fold =
				item.kind === "hook-file" && !item.locked ? t.fg("muted", this.expanded.has(item.id) ? "▾ " : "▸ ") : "";
			push(`${selected ? t.fg("accent", "> ") : "  "}${"  ".repeat(item.depth + 1)}${fold}${box} ${name}${summary}`);
		}
		if (start > 0 || end < this.rows.length) {
			const position = this.rows.slice(0, this.selected + 1).filter((row) => row.type === "item").length;
			push(t.fg("dim", `  (${position}/${items})`));
		}
		const current = this.rows[this.selected];
		if (current?.type === "item") {
			lines.push("");
			const detail = [current.item.detail, current.item.id].filter(Boolean).join(" · ");
			for (const line of wrapTextWithAnsi(sanitizeTerminalText(detail), w - 4).slice(0, 2))
				push(t.fg("muted", `  ${line}`));
		}
		if (this.flash) push(` ${t.fg(this.flash.level, sanitizeTerminalText(this.flash.text))}`);
		if (this.options.summary) push(` ${t.fg("muted", `${this.options.summary}: /harness list shows them`)}`);
		push(t.fg("accent", "─".repeat(w)));
		return lines;
	}
}
