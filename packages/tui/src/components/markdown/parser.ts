import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

export interface LatexToken extends Tokens.Generic {
	type: "latex" | "latexBlock";
	text: string;
	pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(closing, index + closing.length);
	}
	return index;
}

function looksLikePendingDollarMath(source: string): boolean {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			/^\d/.test(source.slice(closingIndex + 1)) ||
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
				/^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	if (closingIndex < 0) {
		const pendingSource = source.slice(opening.length);
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) {
		return undefined;
	}

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1]) {
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1]) {
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingBracket) {
		return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	}
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter((index) => index >= 0);
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];

export function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives..
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

export const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });
