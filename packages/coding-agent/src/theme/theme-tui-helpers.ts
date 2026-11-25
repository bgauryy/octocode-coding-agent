import {
	type EditorTheme,
	GLYPH,
	HighlightCache,
	type MarkdownTheme,
	type SelectListTheme,
} from "@octocodeai/octocode-tui";
import { guessLanguage } from "../utils/code-sniff.ts";
import { highlight, isHighlightable, resolveLanguage } from "../utils/syntax-highlight.ts";
import { selectedText } from "./gradients.ts";
import type { Theme } from "./theme-class.ts";
import type { ThemeColor } from "./theme-types.ts";
import { theme } from "./theme-global.ts";

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
		selectedText: (text: string) => selectedText(text),
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

/** The mark before a list row: the accent cursor on the selected row, two spaces on the rest. */
export const cursorMark = (selected: boolean): string => (selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ");

export {
	formatKeyText,
	keyText,
	interruptKey,
	keyHint,
	TOOL_PREVIEW_LINES,
	rawKeyHint,
	type KeyHintPair,
	hintText,
	hintLine,
	type RankedHint,
	fitHints,
	moveHint,
	renderHintLine,
	HintBar,
	emptyState,
	noMatchMessage,
} from "./hints.ts";
