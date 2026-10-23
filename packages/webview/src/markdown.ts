/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import { marked } from "marked";

for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, diff }))
	hljs.registerLanguage(name, language);

/** Tags a sanitized fragment may contain; renderers must not add others. */
export const MARKDOWN_TAGS = [
	"p",
	"br",
	"hr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"strong",
	"em",
	"del",
	"blockquote",
	"ul",
	"ol",
	"li",
	"pre",
	"code",
	"a",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"span",
] as const;

/** Only external web links are navigable; local paths remain text for explicit inspection. */
export function safeMarkdownLink(value: string): string | null {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

/** The language a fenced block declared, when it is one this page can highlight or label. */
export function codeLanguage(code: Element): string | undefined {
	return code.className.match(/^language-([\w+-]+)$/)?.[1];
}

/**
 * Parse, then sanitize to an allowlisted fragment: links are external-only and open in a new tab, the only class kept is
 * a code block's language (or highlight spans), and known languages are highlighted and sanitized again.
 */
export function sanitizeMarkdown(source: string): DocumentFragment {
	const fragment = DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }), {
		ALLOWED_TAGS: MARKDOWN_TAGS.filter((tag) => tag !== "span"),
		ALLOWED_ATTR: ["href", "title", "class", "start"],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		RETURN_DOM_FRAGMENT: true,
	});
	for (const link of fragment.querySelectorAll("a")) {
		const href = safeMarkdownLink(link.getAttribute("href") ?? "");
		if (href) {
			link.href = href;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
		} else link.removeAttribute("href");
	}
	for (const element of fragment.querySelectorAll("[class]")) {
		const language =
			element.tagName === "CODE" ? [...element.classList].find((name) => /^language-[\w+-]+$/.test(name)) : undefined;
		element.removeAttribute("class");
		if (language) element.className = language;
	}
	for (const code of fragment.querySelectorAll("pre > code")) {
		const language = codeLanguage(code);
		if (!language || !hljs.getLanguage(language)) continue;
		const highlighted = hljs.highlight(code.textContent ?? "", { language, ignoreIllegals: true }).value;
		code.replaceChildren(
			DOMPurify.sanitize(highlighted, { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"], RETURN_DOM_FRAGMENT: true }),
		);
	}
	return fragment;
}
