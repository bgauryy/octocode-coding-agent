import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import dart from "highlight.js/lib/languages/dart";
import go from "highlight.js/lib/languages/go";
import groovy from "highlight.js/lib/languages/groovy";
import java from "highlight.js/lib/languages/java";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import nix from "highlight.js/lib/languages/nix";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import { decodeHtmlEntityAt } from "@octocodeai/octocode-common/html";

const eagerLanguages = {
	python,
	java,
	go,
	javascript,
	json,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
	yaml,
	sql,
	xml,
	css,
	diff,
	markdown,
	ini,
	dockerfile,
	makefile,
};

for (const [name, language] of Object.entries(eagerLanguages)) {
	hljs.registerLanguage(name, language);
}

let allLanguagesPromise: Promise<boolean> | undefined;
let allLanguagesLoaded = false;
/** Language names asked for before the full set loaded and not registered then (bounded: past the cap, assume a change). */
const unresolvedBeforeLoad = new Set<string>();
const UNRESOLVED_NAMES_MAX = 64;
let unresolvedOverflow = false;
/** Told once the full set loaded and code already shown as plain text can now be highlighted. */
const loadListeners = new Set<() => void>();

function noteUnresolved(name: string): void {
	if (allLanguagesLoaded || unresolvedOverflow) return;
	if (unresolvedBeforeLoad.size >= UNRESOLVED_NAMES_MAX) unresolvedOverflow = true;
	else unresolvedBeforeLoad.add(name);
	// The first name the common set does not know loads the rest, on a later turn of the event loop.
	void loadAllHighlightLanguages();
}

/**
 * Register every highlight.js language (once, on a later turn of the event loop). Resolves true when a language name
 * that was asked for before, and fell back to plain text, is now registered: only then can rendered code look different,
 * and only then are the `onHighlightLanguagesLoaded` listeners told. A session whose code uses only the common
 * languages never loads the rest.
 */
export function loadAllHighlightLanguages(): Promise<boolean> {
	allLanguagesPromise ??= new Promise((resolve) => {
		setImmediate(() => {
			// A failed import keeps the eager languages and the plain-text fallback, so nothing rendered changes.
			const settle = (loaded: boolean) => {
				allLanguagesLoaded = true;
				const changed =
					loaded && (unresolvedOverflow || [...unresolvedBeforeLoad].some((name) => hljs.getLanguage(name)));
				unresolvedBeforeLoad.clear();
				resolve(changed);
				if (!changed) return;
				for (const listener of loadListeners) {
					try {
						listener();
					} catch {
						// One view failing to redraw does not keep the others plain.
					}
				}
			};
			void import("highlight.js").then(
				() => settle(true),
				() => settle(false),
			);
		});
	});
	return allLanguagesPromise;
}

/** Call `listener` when loading the full language set made code already rendered as plain text highlightable. */
export function onHighlightLanguagesLoaded(listener: () => void): () => void {
	loadListeners.add(listener);
	return () => loadListeners.delete(listener);
}

type HighlightFormatter = (text: string) => string;
type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	// highlight.js 11 adds modifier classes after the scope (`hljs-title function_`): they refine it to `title.function`.
	const classes = classValue.split(/\s+/);
	const base = classes.find((className) => className.startsWith(HIGHLIGHT_CLASS_PREFIX));
	if (!base) {
		return undefined;
	}
	const scope = base.slice(HIGHLIGHT_CLASS_PREFIX.length);
	const modifier = classes.find((className) => className !== base && className.endsWith("_"));
	return modifier ? `${scope}.${modifier.slice(0, -1)}` : scope;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter
			? textBuffer
					.split("\n")
					.map((line) => (line ? formatter(line) : line))
					.join("\n")
			: textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

/** Fence names models write that highlight.js does not register as aliases, mapped to the language that fits. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	console: "bash",
	shell: "bash",
	shellsession: "bash",
	zsh: "bash",
	sh: "bash",
	yml: "yaml",
	jsonc: "json",
	json5: "json",
	jsonl: "json",
	ndjson: "json",
	vue: "xml",
	svelte: "xml",
	astro: "xml",
	hcl: "ini",
	tf: "ini",
	terraform: "ini",
	conf: "ini",
	env: "ini",
	dotenv: "ini",
	mdx: "markdown",
	patch: "diff",
	jsx: "javascript",
	tsx: "typescript",
	html: "xml",
	svg: "xml",
	docker: "dockerfile",
	make: "makefile",
	md: "markdown",
};

/**
 * The registered highlight.js language for a fence info string or file language name: its first word, lower-cased, with
 * extras such as `title=x`, `{1,3}` or `,linenos` dropped. Undefined when no language fits.
 */
export function resolveLanguage(name: string | undefined): string | undefined {
	const first = name
		?.trim()
		.split(/[\s{,]/, 1)[0]
		?.toLowerCase();
	if (!first) {
		return undefined;
	}
	const mapped = LANGUAGE_ALIASES[first] ?? first;
	if (hljs.getLanguage(mapped)) return mapped;
	noteUnresolved(mapped);
	return undefined;
}

/** Highlighting is skipped above these sizes: hljs runs synchronously on every render of a growing block. */
const MAX_HIGHLIGHT_LINES = 2000;
const MAX_HIGHLIGHT_BYTES = 256 * 1024;
const MAX_HIGHLIGHT_LINE_BYTES = 4096;

/** Whether `code` is small enough to highlight: at most 2000 lines, 256 KB, and no line over 4 KiB. */
export function isHighlightable(code: string): boolean {
	if (code.length > MAX_HIGHLIGHT_BYTES || Buffer.byteLength(code) > MAX_HIGHLIGHT_BYTES) {
		return false;
	}
	const lines = code.split("\n");
	return (
		lines.length <= MAX_HIGHLIGHT_LINES && lines.every((line) => Buffer.byteLength(line) <= MAX_HIGHLIGHT_LINE_BYTES)
	);
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const language = options.language === undefined ? undefined : (resolveLanguage(options.language) ?? options.language);
	const html = language
		? hljs.highlight(code, {
				language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}
