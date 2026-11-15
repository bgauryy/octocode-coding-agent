import {
	type Component,
	type Focusable,
	Input,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { InventoryItem } from "./inventory.ts";
import { blockedReason, type SwitchScope } from "../../core/extensibility/switch.ts";
import type { Theme } from "../../theme/theme.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { shortcutText } from "../shared/keys.ts";
import { type RankedHint, renderHintLine } from "../../theme/theme-tui-helpers.ts";
import { HARNESS_SECTIONS, type HarnessSection } from "./sections.ts";
import { overviewLine } from "./overview.ts";
import { itemDetailLines, itemRowLine, pickerRows, type Row, sectionNav } from "./picker-rows.ts";
import type { McpToolsSource } from "./mcp-tools.ts";
import { McpToolsView } from "./mcp-tools-view.ts";
import { SwitchOnPreview } from "./picker-preview.ts";

type LoadState = "loading" | "ready" | "error";
export interface PickerOptions {
	items: InventoryItem[];
	apply: (item: InventoryItem, on: boolean, scope: SwitchScope, force: boolean) => string;
	paths: Record<SwitchScope, string>;
	height: number | (() => number);
	summary?: string;
	state?: LoadState;
	error?: string;
	section?: HarnessSection;
	retry?: () => void;
	/** The scanned items a harness row would bring when switched on; shown with Enter to confirm before any write. */
	preview?: (item: InventoryItem) => string[] | undefined;
	/** Opens an MCP server's tool rows on Enter or →; absent: Enter switches the server as before. */
	mcpTools?: McpToolsSource;
	done: (changed: boolean) => void;
	requestRender: () => void;
}

/** Peer resource sections share filtering, scope switches and explicit full-detail navigation. */
export class HarnessPicker implements Component, Focusable {
	private readonly search = new Input({ placeholder: "type to filter" });
	private rows: Row[] = [];
	private selected = 0;
	private scope: SwitchScope = "global";
	private section: HarnessSection;
	private state: LoadState;
	private failure: string | undefined;
	private changed = false;
	private flash: { text: string; level: "success" | "warning" } | undefined;
	private armedGate: string | undefined;
	private _focused = false;
	private details = false;
	private tools: McpToolsView | undefined;
	private confirming: { item: InventoryItem; view: SwitchOnPreview } | undefined;
	private detailOffset = 0;
	private detailLength = 0;
	private visibleRows = 5;
	private readonly expanded = new Set<string>();
	private readonly selections = new Map<HarnessSection, string>();
	private readonly options: PickerOptions;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	constructor(options: PickerOptions, theme: Theme, keys: KeybindingsManager) {
		this.options = options;
		this.theme = theme;
		this.keys = keys;
		this.section = options.section ?? "overview";
		this.state = options.state ?? "ready";
		this.failure = options.error;
		this.filter();
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value && !this.details;
	}
	private get height(): number {
		return Math.max(8, typeof this.options.height === "function" ? this.options.height() : this.options.height);
	}
	private get current(): InventoryItem | undefined {
		const row = this.rows[this.selected];
		return row?.type === "item" ? row.item : undefined;
	}

	private get currentKey(): string | undefined {
		const row = this.rows[this.selected];
		return row?.type === "section" ? row.row.section : this.current?.id;
	}

	loaded(items: InventoryItem[], summary?: string): void {
		const keep = this.currentKey;
		this.options.items = items;
		this.options.summary = summary;
		this.state = "ready";
		this.failure = undefined;
		this.filter(keep);
		this.options.requestRender();
	}
	failed(error: string): void {
		this.state = "error";
		this.failure = error;
		this.options.requestRender();
	}

	private filter(keep?: string): void {
		this.rows = pickerRows(
			this.options.items,
			this.section,
			this.search.getValue().trim().toLowerCase(),
			this.expanded,
		);
		const kept = this.rows.findIndex((row) =>
			row.type === "section" ? row.row.section === keep : row.type === "item" && row.item.id === keep,
		);
		this.selected =
			kept >= 0
				? kept
				: Math.max(
						0,
						this.rows.findIndex((row) => row.type !== "host"),
					);
	}
	private openTools(item: InventoryItem): void {
		const source = this.options.mcpTools;
		if (!source) return;
		try {
			this.tools = new McpToolsView(item.name ?? item.label, source, this.scope, this.theme, this.keys);
			this.flash = undefined;
		} catch (error) {
			this.flash = { text: errorMessage(error), level: "warning" };
		}
	}
	private openSection(target: HarnessSection): void {
		if (this.current) this.selections.set(this.section, this.current.id);
		const from = this.section;
		this.section = target;
		this.search.setValue("");
		this.filter(target === "overview" ? from : this.selections.get(target));
		this.flash = undefined;
	}
	private moveSection(direction: 1 | -1): void {
		const sections = Object.keys(HARNESS_SECTIONS) as HarnessSection[];
		this.openSection(sections[(sections.indexOf(this.section) + direction + sections.length) % sections.length]);
	}
	private foldFile(item: InventoryItem): string | undefined {
		return item.kind === "hook" ? item.parents?.[0] : item.kind === "hook-file" ? item.id : undefined;
	}
	/** Plain ←/→: a hook file opens or closes first, anything else moves to the neighbouring section. */
	private arrow(direction: 1 | -1): void {
		const file = this.current && this.foldFile(this.current);
		if (this.current && file && (direction === 1 ? !this.expanded.has(file) : this.expanded.has(file)))
			this.fold(this.current, direction === 1);
		else this.moveSection(direction);
	}
	private fold(item: InventoryItem, open: boolean): void {
		const file = this.foldFile(item);
		if (!file) return;
		if (open) this.expanded.add(file);
		else this.expanded.delete(file);
		this.filter(open ? item.id : file);
	}
	private step(direction: 1 | -1, distance = 1): void {
		let index = Math.min(this.rows.length - 1, Math.max(0, this.selected + direction * distance));
		while (index >= 0 && index < this.rows.length && this.rows[index].type === "host") index += direction;
		if (index >= 0 && index < this.rows.length) this.selected = index;
	}
	private toggle(item: InventoryItem, confirmed = false): void {
		const reason = blockedReason(item, this.scope);
		if (reason) {
			this.flash = { text: `${item.label}: ${reason}`, level: "warning" };
			return;
		}
		const on = !item.on,
			force = this.armedGate === item.id;
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
			const lines = on && !confirmed && item.kind === "harness" ? this.options.preview?.(item) : undefined;
			if (lines) {
				this.confirming = { item, view: new SwitchOnPreview(`Turn on ${item.label}?`, lines, this.theme, this.keys) };
				return;
			}
			this.flash = { text: this.options.apply(item, on, this.scope, force), level: "success" };
			item.on = on;
			this.changed = true;
		} catch (error) {
			this.flash = { text: errorMessage(error), level: "warning" };
		}
	}
	handleInput(data: string): void {
		const cancel = this.keys.matches(data, "tui.select.cancel");
		if (matchesKey(data, "ctrl+c") || (cancel && !this.details && !this.tools && !this.confirming)) {
			this.options.done(this.changed || this.tools?.changed === true);
			return;
		}
		if (this.confirming) {
			const answer = this.confirming.view.handleInput(data);
			const { item } = this.confirming;
			if (answer) this.confirming = undefined;
			if (answer === "confirm") this.toggle(item, true);
			else if (answer) this.flash = { text: `${item.label} stays off; nothing was written.`, level: "warning" };
			this.options.requestRender();
			return;
		}
		if (this.tools) {
			if (this.tools.handleInput(data) === "back") {
				this.changed ||= this.tools.changed;
				this.tools = undefined;
			}
			this.options.requestRender();
			return;
		}
		const ready = this.state === "ready" && !this.details;
		const confirm = this.keys.matches(data, "tui.select.confirm");
		const opensTools =
			ready &&
			this.current?.kind === "mcp" &&
			!!this.options.mcpTools &&
			(confirm || (matchesKey(data, "right") && !this.search.getValue()));
		const toggle = ready && !opensTools && (confirm || (data === " " && !this.search.getValue()));
		if (!toggle) this.armedGate = undefined;
		if (this.details) {
			if (cancel || matchesKey(data, "f2") || this.keys.matches(data, "tui.select.confirm")) {
				this.details = false;
				this.search.focused = this.focused;
			} else if (this.keys.matches(data, "tui.select.up")) this.detailOffset = Math.max(0, this.detailOffset - 1);
			else if (this.keys.matches(data, "tui.select.down"))
				this.detailOffset = Math.min(Math.max(0, this.detailLength - this.visibleRows), this.detailOffset + 1);
			else if (this.keys.matches(data, "tui.select.pageUp"))
				this.detailOffset = Math.max(0, this.detailOffset - this.visibleRows);
			else if (this.keys.matches(data, "tui.select.pageDown"))
				this.detailOffset = Math.min(
					Math.max(0, this.detailLength - this.visibleRows),
					this.detailOffset + this.visibleRows,
				);
		} else if (this.state !== "ready") {
			if (this.state === "error" && matchesKey(data, "ctrl+r") && this.options.retry) {
				this.state = "loading";
				this.failure = undefined;
				this.options.retry();
			}
		} else if (matchesKey(data, "ctrl+right") || matchesKey(data, "ctrl+left"))
			this.moveSection(matchesKey(data, "ctrl+right") ? 1 : -1);
		else if (matchesKey(data, "f2") && this.current) {
			this.details = true;
			this.detailOffset = 0;
			this.search.focused = false;
		} else if (this.keys.matches(data, "tui.select.up")) this.step(-1);
		else if (this.keys.matches(data, "tui.select.down")) this.step(1);
		else if (this.keys.matches(data, "tui.select.pageUp")) this.step(-1, this.visibleRows);
		else if (this.keys.matches(data, "tui.select.pageDown")) this.step(1, this.visibleRows);
		else if (opensTools && this.current) this.openTools(this.current);
		else if ((matchesKey(data, "right") || matchesKey(data, "left")) && !this.search.getValue()) {
			this.arrow(matchesKey(data, "right") ? 1 : -1);
		} else if (this.keys.matches(data, "tui.input.tab")) {
			this.scope = this.scope === "global" ? "project" : "global";
			this.flash = undefined;
		} else if (toggle) {
			const row = this.rows[this.selected];
			if (row?.type === "section") this.openSection(row.row.section);
			else if (this.current) this.toggle(this.current);
		} else if (this.section !== "overview") {
			this.search.handleInput(data);
			this.filter();
			this.flash = undefined;
		}
		this.options.requestRender();
	}
	invalidate(): void {}

	private detailLines(width: number): string[] {
		const item = this.current;
		return item
			? itemDetailLines(
					item,
					this.scope,
					this.options.paths[this.scope],
					width,
					!!this.options.mcpTools && item.kind === "mcp",
				)
			: [];
	}
	render(width: number): string[] {
		const t = this.theme,
			w = Math.max(20, width),
			height = this.height;
		const lines: string[] = [],
			push = (line: string) => lines.push(truncateToWidth(line, w, "…"));
		push(t.fg("border", "─".repeat(w)));
		const open = this.confirming?.view ?? this.tools;
		if (open) return [...lines, ...open.render(w, height - 2), t.fg("border", "─".repeat(w))];
		push(
			` ${t.fg("accent", t.bold(this.details ? `Harness › ${HARNESS_SECTIONS[this.section].title} › Details` : "Harness — skills, MCPs, hooks and sources"))}`,
		);
		if (this.details) {
			const detail = this.detailLines(w);
			this.detailLength = detail.length;
			this.visibleRows = Math.max(1, height - 5);
			this.detailOffset = Math.min(this.detailOffset, Math.max(0, detail.length - this.visibleRows));
			for (const line of detail.slice(this.detailOffset, this.detailOffset + this.visibleRows)) push(` ${line}`);
			push(
				t.fg(
					"dim",
					` ${this.detailOffset + 1}–${Math.min(detail.length, this.detailOffset + this.visibleRows)}/${detail.length}`,
				),
			);
			push(t.fg("muted", " ↑↓ / PgUp PgDn scroll · F2 / Esc back"));
		} else {
			const nav = sectionNav(this.options.items, this.section, this.state === "ready", t);
			for (const line of wrapTextWithAnsi(nav, w).slice(0, height < 12 ? 1 : 2)) push(line);
			if (this.state !== "ready") {
				const message =
					this.state === "loading"
						? "Loading skills, MCPs and hooks…"
						: `Could not load harness inventory. ${this.failure ?? ""}`;
				for (const line of wrapTextWithAnsi(sanitizeTerminalText(message), w - 2).slice(
					0,
					Math.max(1, height - lines.length - 2),
				))
					push(` ${t.fg(this.state === "error" ? "warning" : "muted", line)}`);
				push(t.fg("muted", this.state === "error" && this.options.retry ? " Ctrl+R retry · Esc close" : " Esc close"));
			} else {
				const overview = this.section === "overview";
				const mcpTools = this.section === "mcp" && !!this.options.mcpTools;
				if (height >= 16 && !overview)
					push(t.fg("muted", `Switch scope: ${this.scope} · writes ${this.options.paths[this.scope]}`));
				if (!overview) lines.push(...this.search.render(w));
				const current = this.current;
				const footer: string[] = [];
				if (current && height >= 18)
					footer.push(
						...this.detailLines(w)
							.slice(0, 2)
							.map((line) => t.fg("muted", ` ${line}`)),
					);
				if (this.flash) footer.push(t.fg(this.flash.level, ` ${sanitizeTerminalText(this.flash.text)}`));
				if (this.options.summary && height >= 20)
					footer.push(t.fg("muted", ` ${this.options.summary} · /harness list`));
				const hints: RankedHint[] = [
					[shortcutText("tui.select.cancel", this.keys), "close", 0],
					["←/→", "section", 1],
					["Enter", overview ? "open" : mcpTools ? "tools" : "toggle", 1],
					...(mcpTools ? ([["Space", "switch", 1]] as RankedHint[]) : []),
					...(overview
						? []
						: ([
								["F2", "details", 1],
								[shortcutText("tui.input.tab", this.keys), "scope", 2],
							] as RankedHint[])),
				];
				footer.push(renderHintLine(hints, w));
				const available = height - lines.length - footer.length - 1;
				const position = this.rows.length > available && available > 1;
				this.visibleRows = Math.max(1, available - Number(position));
				const start = Math.max(
					0,
					Math.min(this.selected - Math.floor(this.visibleRows / 2), this.rows.length - this.visibleRows),
				);
				const shown = this.rows.slice(start, start + this.visibleRows);
				if (!this.rows.length) {
					const message = this.search.getValue().trim()
						? "Nothing matches this filter. Clear it to see this section."
						: HARNESS_SECTIONS[this.section].empty;
					for (const line of wrapTextWithAnsi(message, w - 2).slice(0, this.visibleRows))
						push(t.fg("muted", ` ${line}`));
				}
				for (const [offset, row] of shown.entries()) {
					if (row.type === "section") {
						push(overviewLine(row.row, start + offset === this.selected, t));
						continue;
					}
					if (row.type === "host") {
						push(` ${t.fg("accent", t.bold(row.title))}`);
						continue;
					}
					const selected = start + offset === this.selected;
					push(itemRowLine(row.item, { selected, scope: this.scope, expanded: this.expanded.has(row.item.id) }, t));
				}
				if (position && this.rows.length > shown.length)
					push(t.fg("dim", ` ${this.selected + 1}/${this.rows.length} · ↑↓ / PgUp PgDn`));
				for (const line of footer) push(line);
			}
		}
		push(t.fg("border", "─".repeat(w)));
		return lines.slice(0, height);
	}
}
