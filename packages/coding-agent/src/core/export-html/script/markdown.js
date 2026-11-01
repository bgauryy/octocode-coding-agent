// ============================================================
// INITIALIZATION
// ============================================================

// Configure marked with syntax highlighting and TUI-compatible HTML handling
const strictStrikethroughRegex = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

marked.use({
	breaks: true,
	gfm: true,
	tokenizer: {
		// Treat HTML-like input as plain text so tags are shown verbatim,
		// matching the TUI markdown renderer.
		html() {
			return undefined;
		},
		tag() {
			return undefined;
		},
		del(src) {
			const match = strictStrikethroughRegex.exec(src);
			if (!match) return undefined;
			return {
				type: "del",
				raw: match[0],
				text: match[2],
				tokens: this.lexer.inlineTokens(match[2]),
			};
		},
	},
	renderer: {
		// Sanitize link URLs with a scheme allow-list. Browsers strip C0
		// controls from schemes, so strip them before checking and emitting.
		link(token) {
			const href = sanitizeMarkdownUrl(token.href);
			if (href === null) {
				return this.parser.parseInline(token.tokens);
			}
			let out = '<a href="' + escapeHtml(href) + '"';
			if (token.title) {
				out += ' title="' + escapeHtml(token.title) + '"';
			}
			out += ">" + this.parser.parseInline(token.tokens) + "</a>";
			return out;
		},
		// Sanitize image src URLs with the same scheme allow-list.
		image(token) {
			const href = sanitizeMarkdownUrl(token.href);
			if (href === null) {
				return escapeHtml(token.text || "");
			}
			let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || "") + '"';
			if (token.title) {
				out += ' title="' + escapeHtml(token.title) + '"';
			}
			out += ">";
			return out;
		},
		// Code blocks: syntax highlight, no HTML escaping
		code(token) {
			const code = token.text;
			const lang = token.lang;
			let highlighted;
			if (lang && hljs.getLanguage(lang)) {
				try {
					highlighted = hljs.highlight(code, { language: lang }).value;
				} catch {
					highlighted = escapeHtml(code);
				}
			} else {
				// Auto-detect language if not specified
				try {
					highlighted = hljs.highlightAuto(code).value;
				} catch {
					highlighted = escapeHtml(code);
				}
			}
			return `<pre><code class="hljs">${highlighted}</code></pre>`;
		},
		// Inline code: escape HTML
		codespan(token) {
			return `<code>${escapeHtml(token.text)}</code>`;
		},
	},
});

// Simple marked parse (escaping handled in renderers)
function safeMarkedParse(text) {
	return marked.parse(text);
}
