import {
	Lexer,
	Marked,
	type MarkedOptions,
	type Token,
	Tokenizer,
	type TokenizerExtension,
	type Tokens,
	type TokensList,
} from "marked";
import { indexStrikethrough, matchStrikethrough, type StrikethroughIndex } from "./strikethrough.ts";

const LATEX_INLINE_OPENERS = ["$", "\\(", "\\["] as const;

/**
 * One inline run being lexed. Marked hands tokenizers and `start` functions suffixes of the run, one
 * per position, so per-call scans to the end are quadratic; these caches make each scan once per run.
 */
interface InlineRun {
	readonly source: string;
	/** Strikethrough closers and blocks, built on the first `~~`. */
	strikethrough?: StrikethroughIndex;
	/** Per latex opener: the run position its last search started from, and what it found (-1: none). */
	latexSearches?: Array<{ from: number; found: number }>;
}

class StrictStrikethroughTokenizer extends Tokenizer {
	/** Inline runs in progress, innermost last. */
	readonly runs: InlineRun[] = [];

	/** The innermost run and the position of `suffix` in it; a fresh run when lexed without StrictStrikethroughLexer. */
	locate(suffix: string): { run: InlineRun; offset: number } {
		const run = this.runs.at(-1);
		const offset = run ? run.source.length - suffix.length : -1;
		if (!run || offset < 0 || !run.source.startsWith(suffix.slice(0, 3), offset)) {
			return { run: { source: suffix }, offset: 0 };
		}
		return { run, offset };
	}

	/** Where the next inline latex opener starts in `suffix`, as the latex extension's `start` reports it. */
	latexStart(suffix: string): number | undefined {
		const { run, offset } = this.locate(suffix);
		const searches = (run.latexSearches ??= LATEX_INLINE_OPENERS.map(() => ({ from: -1, found: -1 })));
		let next = -1;
		for (let i = 0; i < LATEX_INLINE_OPENERS.length; i++) {
			const search = searches[i];
			// A search from an earlier position stays valid until the position passes what it found.
			if (search.from < 0 || offset < search.from || (search.found >= 0 && search.found < offset)) {
				search.from = offset;
				search.found = run.source.indexOf(LATEX_INLINE_OPENERS[i], offset);
			}
			if (search.found >= 0 && (next < 0 || search.found < next)) next = search.found;
		}
		return next < 0 ? undefined : next - offset;
	}

	override del(src: string): Tokens.Del | undefined {
		if (!src.startsWith("~~")) return undefined;
		const { run, offset } = this.locate(src);
		run.strikethrough ??= indexStrikethrough(run.source);
		const match = matchStrikethrough(run.source, run.strikethrough, offset);
		if (!match) {
			return undefined;
		}

		return {
			type: "del",
			raw: match.raw,
			text: match.text,
			tokens: this.lexer.inlineTokens(match.text),
		};
	}
}

/** Tells the tokenizer which inline run it is reading, so `del` can map its suffix to a position. */
class StrictStrikethroughLexer extends Lexer {
	private readonly strikethrough: StrictStrikethroughTokenizer;

	constructor(options: MarkedOptions, strikethrough: StrictStrikethroughTokenizer) {
		super(options);
		this.strikethrough = strikethrough;
	}

	override inlineTokens(src: string, tokens?: Token[]): Token[] {
		this.strikethrough.runs.push({ source: src });
		try {
			return super.inlineTokens(src, tokens);
		} finally {
			this.strikethrough.runs.pop();
		}
	}
}

const inlineTokenizer = new StrictStrikethroughTokenizer();

class StrictStrikethroughMarked extends Marked {
	constructor() {
		super();
		this.setOptions({ tokenizer: inlineTokenizer });
	}

	override lexer(src: string, options?: MarkedOptions): TokensList {
		return new StrictStrikethroughLexer(options ?? this.defaults, inlineTokenizer).lex(src);
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
			return inlineTokenizer.latexStart(source);
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

export const markdownParser = new StrictStrikethroughMarked();
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });
