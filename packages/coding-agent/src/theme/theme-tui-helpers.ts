import {
	type Component,
	type EditorTheme,
	getKeybindings,
	GLYPH,
	type Keybinding,
	type KeyId,
	type MarkdownTheme,
	type SelectListTheme,
	SEPARATOR,
	type SettingsListTheme,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { guessLanguage } from "../utils/code-sniff.ts";
import { highlight, isHighlightable, resolveLanguage } from "../utils/syntax-highlight.ts";
import type { Theme } from "./theme-class.ts";
import type { ThemeColor } from "./theme-types.ts";
import { theme } from "./theme-global.ts";
import { HighlightCache } from "./highlight-cache.ts";

/** The GitHub alert kinds a `MarkdownTheme` styles. */
type MarkdownAlertKind = Parameters<NonNullable<MarkdownTheme["alert"]>>[0];

const ALERT_COLORS: Record<MarkdownAlertKind, ThemeColor> = {
	note: "accent",
	tip: "success",
	important: "mdHeading",
	warning: "warning",
	caution: "error",
};

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		subst: (s: string) => t.fg("text", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		"title.class": (s: string) => t.fg("syntaxType", s),
		"title.function": (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		selector: (s: string) => t.fg("syntaxKeyword", s),
		attribute: (s: string) => t.fg("syntaxVariable", s),
		property: (s: string) => t.fg("syntaxVariable", s),
		symbol: (s: string) => t.fg("syntaxNumber", s),
		section: (s: string) => t.fg("syntaxFunction", s),
		bullet: (s: string) => t.fg("syntaxPunctuation", s),
		"template-variable": (s: string) => t.fg("syntaxVariable", s),
		code: (s: string) => t.fg("syntaxString", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/** Up to the largest block `isHighlightable` allows: expanding, collapsing or resizing a big result must not re-run hljs. */
const HIGHLIGHT_CACHE_MAX_CHARS = 256 * 1024;
const highlightCaches = new WeakMap<Theme, HighlightCache>();

/**
 * Highlight code with syntax coloring based on file extension or language, in `source` (the active theme by default).
 * Returns array of highlighted lines; unknown languages, oversized code (see `isHighlightable`) and highlighter
 * failures use the code-block color. Recent results are cached per theme so a re-render of unchanged code is free.
 */
export function highlightCode(code: string, lang?: string, source: Theme = theme): string[] {
	// Skip highlighting when no valid language is specified: auto-detection is unreliable and can misidentify prose
	// as AppleScript, LiveCodeServer, etc., coloring random English words as keywords. A block with no language at
	// all is coloured only when its shape settles it (one JSON document, a unified diff).
	const validLang = resolveLanguage(lang) ?? (lang?.trim() ? undefined : guessLanguage(code));
	if (validLang && isHighlightable(code)) {
		const cacheable = code.length <= HIGHLIGHT_CACHE_MAX_CHARS;
		const key = `${validLang}\0${code}`;
		let cache = highlightCaches.get(source);
		const hit = cacheable ? cache?.get(key) : undefined;
		if (hit) {
			return hit.slice();
		}
		try {
			const lines = highlight(code, {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(source),
			}).split("\n");
			if (cacheable) {
				if (!cache) {
					cache = new HighlightCache();
					highlightCaches.set(source, cache);
				}
				cache.set(key, lines);
			}
			return lines.slice();
		} catch {
			// Fall through to the plain code-block color.
		}
	}
	return code.split("\n").map((line) => source.fg("mdCodeBlock", line));
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

/** Markdown styles from `source`: the active theme by default, or a theme instance a renderer was given. */
export function getMarkdownTheme(source: Theme = theme): MarkdownTheme {
	const theme = source;
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		codeBlockLabel: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => theme.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => highlightCode(code, lang, theme),
		alert: (kind: MarkdownAlertKind, text: string) => theme.fg(ALERT_COLORS[kind], text),
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		matchHighlight: (text: string) => theme.bold(theme.fg("accent", text)),
		directory: (text: string) => theme.fg("mdLink", text),
		hint: (text: string) => theme.fg("dim", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		ghostText: (text: string) => theme.fg("dim", text),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", `${GLYPH.cursor} `),
		hint: (text: string) => theme.fg("dim", text),
	};
}

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

/**
 * The one fold hint under a collapsed preview: `… +12 lines (ctrl+o to expand)`. `earlier` names the hidden head of a
 * preview that keeps the last lines: `… +12 earlier lines (ctrl+o to expand)`. Without a bound key, only the count.
 */
export function foldHint(hidden: number, earlier = false): string {
	const lines = `${hidden} ${earlier ? "earlier " : ""}${hidden === 1 ? "line" : "lines"}`;
	const key = keyText("app.tools.expand");
	return theme.fg("dim", `… +${lines}${key ? ` (${key} to expand)` : ""}`);
}

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
