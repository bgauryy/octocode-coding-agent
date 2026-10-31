import type { Token } from "marked";
import { markdownParser, trimPartialClosingFences } from "./parser.ts";

/** The top-level tokens of a Markdown source. */
export interface LexedMarkdown {
	source: string;
	tokens: Token[];
	/**
	 * Whether a later source that extends this one can keep the leading tokens: their raw text adds up to the source and
	 * no link reference definition exists (a definition changes how inline links elsewhere in the text parse).
	 */
	extendable: boolean;
}

/** A link reference definition line: `[label]: destination`. */
const LINK_DEFINITION = /^ {0,3}\[[^\]\n]*\]:/m;

function rawLength(tokens: readonly Token[], end: number): number {
	let length = 0;
	for (let i = 0; i < end; i++) length += tokens[i].raw.length;
	return length;
}

/**
 * Index of the first token to lex again when the source grows: the second-to-last block that holds content, so the
 * last block and the block before it are re-read. Anything earlier was ended by text that follows it and cannot change.
 */
function restartIndex(tokens: readonly Token[]): number {
	let i = tokens.length - 1;
	while (i >= 0 && tokens[i].type === "space") i--;
	return i - 1;
}

function lexFully(source: string): LexedMarkdown {
	const tokens = markdownParser.lexer(source);
	trimPartialClosingFences(tokens);
	let joined = "";
	for (const token of tokens) joined += token.raw;
	return { source, tokens, extendable: joined === source && !LINK_DEFINITION.test(source) };
}

/**
 * Lex `source`. When it extends the previous lexed source, the leading blocks that appended text cannot change keep
 * their tokens (the same objects, so a cache keyed by token survives) and only the tail is lexed again. Any other
 * edit, or a source whose tokens do not cover it exactly, lexes in full; the result is the same either way.
 */
export function lexMarkdown(source: string, previous?: LexedMarkdown): LexedMarkdown {
	if (previous?.extendable && source.length > previous.source.length && source.startsWith(previous.source)) {
		const restart = restartIndex(previous.tokens);
		if (restart > 0) {
			const offset = rawLength(previous.tokens, restart);
			const tail = source.slice(offset);
			if (!LINK_DEFINITION.test(tail)) {
				const tailTokens = markdownParser.lexer(tail);
				let joined = "";
				for (const token of tailTokens) joined += token.raw;
				if (joined === tail) {
					const tokens = [...previous.tokens.slice(0, restart), ...tailTokens];
					trimPartialClosingFences(tokens);
					return { source, tokens, extendable: true };
				}
			}
		}
	}
	return lexFully(source);
}
