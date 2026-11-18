import {
	type Component,
	type KeyId,
	type Keybinding,
	SEPARATOR,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { theme } from "./theme-global.ts";

// Keybinding hints as every surface shows them: terminal components, tool renderers in core and native UI.

/**
 * Key text as every hint, chip and shortcut table shows it: lowercase (`shift+tab`, `ctrl+c`), with `option` for `alt`
 * on macOS.
 */
export function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => {
					const lower = part.toLowerCase();
					if (lower === "escape") return "esc";
					return process.platform === "darwin" && lower === "alt" ? "option" : lower;
				})
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"));
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

/** The interrupt key as every hint shows it: `esc`, not `escape`. */
export function interruptKey(): string {
	return keyText("app.interrupt");
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

/** Result lines a collapsed tool row shows before its fold hint. */
export const TOOL_PREVIEW_LINES = 5;

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

/** A key and the verb it triggers: `[keyText("tui.select.confirm"), "select"]`. Say `interrupt` for the agent run, `cancel` for a dialog. */
export type KeyHintPair = readonly [key: string, verb: string];

/** Plain `key verb · key verb`, for text a caller colors itself or measures. */
export function hintText(hints: readonly KeyHintPair[]): string {
	return hints.map(([key, verb]) => `${formatKeyText(key)} ${verb}`).join(SEPARATOR);
}

/** The one key-hint line of selectors, dialogs and indicators: `key verb · key verb` in `rawKeyHint` colors. */
export function hintLine(hints: readonly KeyHintPair[]): string {
	return hints.map(([key, verb]) => rawKeyHint(key, verb)).join(theme.fg("dim", SEPARATOR));
}

/** A key hint with an optional rank: a lower number is kept longer. Hints without one rank by their position. */
export type RankedHint = readonly [key: string, verb: string, rank?: number];

/** The hints that fit `width` columns, in their original order: when they do not fit, the least important go first. */
export function fitHints(hints: readonly RankedHint[], width: number): KeyHintPair[] {
	const kept = hints.map((hint, index) => ({ pair: [hint[0], hint[1]] as KeyHintPair, rank: hint[2] ?? index, index }));
	while (kept.length > 1 && visibleWidth(hintText(kept.map((entry) => entry.pair))) > width) {
		let drop = 0;
		for (let i = 1; i < kept.length; i++) {
			if (kept[i].rank > kept[drop].rank || (kept[i].rank === kept[drop].rank && kept[i].index > kept[drop].index))
				drop = i;
		}
		kept.splice(drop, 1);
	}
	return kept.map((entry) => entry.pair);
}

/**
 * The move hint of every list page: `↑/↓ move` from the bound select keys. Rank it by how soon it may go on a narrow
 * terminal; the default keeps it just after the confirm and cancel keys.
 */
export function moveHint(rank = 5): RankedHint {
	const arrow = (key: string | undefined, fallback: string) =>
		(key ?? fallback).replace(/^up$/, "↑").replace(/^down$/, "↓");
	const keys = getKeybindings();
	const up = arrow(keys.getKeys("tui.select.up")[0], "↑");
	const down = arrow(keys.getKeys("tui.select.down")[0], "↓");
	return [`${up}/${down}`, "move", rank];
}

/** One line of key hints, indented by `indent` columns; the last hint left is cut with an ellipsis, never wrapped. */
export function renderHintLine(hints: readonly RankedHint[], width: number, indent = 1): string {
	const room = Math.max(1, width - indent);
	return truncateToWidth(`${" ".repeat(indent)}${hintLine(fitHints(hints, room))}`, width, "…");
}

/** The one key-hint line of every selector, fitted to the width. */
export class HintBar implements Component {
	private hints: readonly RankedHint[];
	private readonly indent: number;

	constructor(hints: readonly RankedHint[], indent = 1) {
		this.hints = hints;
		this.indent = indent;
	}

	setHints(hints: readonly RankedHint[]): void {
		this.hints = hints;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [renderHintLine(this.hints, width, this.indent)];
	}
}

/**
 * The line a list shows when it has nothing to list: 2-space indent, muted, and the one key that recovers
 * (`No sessions match "x" · esc clears`). Cut to `width` with an ellipsis when given.
 */
export function emptyState(message: string, recover?: readonly [key: string, verb: string], width?: number): string {
	const line = `  ${theme.fg("muted", message)}${recover ? `${theme.fg("dim", " · ")}${rawKeyHint(recover[0], recover[1])}` : ""}`;
	return width === undefined ? line : truncateToWidth(line, width, "…");
}

/** `No things match "query"` when a search is active, else `No things`. */
export function noMatchMessage(things: string, query = ""): string {
	const text = query.trim();
	return text ? `No ${things} match "${text}"` : `No ${things}`;
}
