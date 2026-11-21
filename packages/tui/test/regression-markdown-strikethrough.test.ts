import assert from "node:assert";
import { describe, it } from "node:test";
import { Lexer, Marked, Tokenizer, type Tokens } from "marked";
import { markdownParser } from "../src/components/markdown/parser.ts";
import { indexStrikethrough, matchStrikethrough } from "../src/components/markdown/strikethrough.ts";

// The strict strikethrough rule before it became linear; the oracle for identical output.
const REFERENCE_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class ReferenceTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = REFERENCE_REGEX.exec(src);
		if (!match) return undefined;
		return { type: "del", raw: match[0], text: match[2], tokens: this.lexer.inlineTokens(match[2]) };
	}
}

const reference = new Marked();
reference.setOptions({ tokenizer: new ReferenceTokenizer() });

/** CPU time of this process for one lex, the best of three runs: other processes' load stretches the wall clock. */
function lexCpuMs(source: string): number {
	let best = Number.POSITIVE_INFINITY;
	for (let run = 0; run < 3; run++) {
		const start = process.cpuUsage();
		markdownParser.lexer(source);
		const used = process.cpuUsage(start);
		best = Math.min(best, (used.user + used.system) / 1000);
	}
	return best;
}

/**
 * Lexing four times the input must cost about four times the CPU: a linear lexer lands near 4, a quadratic one near
 * 16. The ratio holds on a loaded machine, where an absolute time budget does not.
 */
function assertLinearScaling(make: (units: number) => string, units: number, what: string): void {
	const small = Math.max(lexCpuMs(make(units)), 1);
	const large = lexCpuMs(make(units * 4));
	assert.ok(
		large / small < 8,
		`${what}: 4x the input took ${(large / small).toFixed(1)}x the CPU (${small.toFixed(0)} -> ${large.toFixed(0)} ms)`,
	);
}

const CORPUS = [
	"~~done~~",
	"~~a~~",
	"~~ a~~",
	"~~a ~~",
	"~~~a~~~",
	"~~a~~~",
	"~~a~~b~~",
	"x ~~a~~ y ~~b c~~ z",
	"~~a\\~~",
	"~~a\\~~~",
	"~~a\\\\~~",
	"~~\\~~~",
	"~~a\\\n~~b~~",
	"~~a\nb~~",
	"~~a\n\nb~~",
	"~~a\\",
	"~~\\",
	"~~\u00a0a~~",
	"~~a\u00a0~~",
	"~~a\u2028b~~",
	"~~a\\\u2028b~~",
	"~~**bold**~~ and ~~*em*~~",
	"~~`code~~`~~",
	"~~nested ~~inner~~ outer~~",
	"~a~ ~~b~~ ~~~c~~~",
	"a ~~ b ~~ c",
	"~~a~~~~b~~",
	"\\~~a~~",
	"~~\ud83d\ude00~~",
	"- ~~item~~\n- ~~two",
	"> ~~quote\n> more~~",
	"~~a ".repeat(50),
];

const ALPHABET = ["~", "~", "~", "a", "b", " ", "\\", "\\", "\n", "\r", "\t", "\u00a0", "\u2028", "*", "_", "`"];

/** Deterministic pseudo-random strings over the characters that decide a strikethrough match. */
function randomStrings(count: number, maxLength: number, alphabet: readonly string[] = ALPHABET): string[] {
	let seed = 0x2545f491;
	const next = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) / 0x1_0000_0000;
	};
	return Array.from({ length: count }, () => {
		const length = 1 + Math.floor(next() * maxLength);
		return Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
	});
}

function lexed(parser: Marked, source: string): string {
	return JSON.stringify(parser.lexer(source));
}

describe("strict strikethrough", () => {
	it("matches exactly what the reference regex matches at every offset", () => {
		let compared = 0;
		for (const source of [...CORPUS, ...randomStrings(4000, 24)]) {
			const index = indexStrikethrough(source);
			for (let offset = 0; offset < source.length; offset++) {
				const expected = REFERENCE_REGEX.exec(source.slice(offset));
				const actual = matchStrikethrough(source, index, offset);
				assert.deepStrictEqual(
					actual,
					expected ? { raw: expected[0], text: expected[2] } : undefined,
					`${JSON.stringify(source)} at ${offset}`,
				);
				compared++;
			}
		}
		assert.ok(compared > 40_000);
	});

	it("lexes Markdown into the same tokens as the reference tokenizer", () => {
		// No `$`, `\(` or `\[`: the reference parser has no latex extensions.
		for (const source of [...CORPUS, ...randomStrings(1500, 40)]) {
			assert.strictEqual(lexed(markdownParser, source), lexed(reference, source), JSON.stringify(source));
		}
	});

	it("lexes latex and strikethrough like a per-call scan of each suffix", () => {
		// marked's own Lexer gives the tokenizer no run, so every call scans its suffix afresh (the old cost).
		const latexAlphabet = [...ALPHABET, "$", "$", "(", ")", "[", "]", "x", "^"];
		const corpus = [
			"$x$ ~~a~~ \\(y\\) \\[z\\]",
			"~~$x$~~ and $~~a~~$",
			"a $b c$ d $$e$$ \\(f",
			"**$x$** ~~\\(y\\)~~ [link $z$](u) ~~",
			"$$\nx^2\n$$\n~~after~~",
		];
		for (const source of [...corpus, ...randomStrings(1500, 40, latexAlphabet)]) {
			const expected = JSON.stringify(Lexer.lex(source, markdownParser.defaults));
			assert.strictEqual(JSON.stringify(markdownParser.lexer(source)), expected, JSON.stringify(source));
		}
	});

	it("lexes many unclosed openers in linear time", () => {
		// The reference regex took about 1.8 s for 20,000 openers and 7.2 s for 40,000.
		assertLinearScaling((units) => "~~a ".repeat(units), 10_000, "strikethrough openers");
		const tokens = markdownParser.lexer("~~a ".repeat(40_000));
		assert.ok(!JSON.stringify(tokens).includes('"type":"del"'));
	});

	it("finds inline latex openers in linear time", () => {
		// Each text step searched the rest of the run for `$`, `\(` and `\[`: 320 KB of "~a b" took 4.6 s.
		assertLinearScaling((units) => "~a b".repeat(units), 20_000, "inline latex openers");
	});

	it("keeps block math starts identical in nested blocks and at paragraph boundaries", () => {
		const cases = [
			"before\n\n$$\nx^2\n$$\n\nafter",
			"before\n  \\[x^2\\]\n\nafter",
			"> before\n>\n> $$\n> x^2\n> $$\n> after",
			"- before\n\n  $$\n  x^2\n  $$\n\n- after",
			"a\n\n    $$not block$$\n\n  $$yes$$\n\nend",
			"paragraph $$inline$$\n\n```text\n$$not math$$\n```\n\nend",
		];
		for (const source of cases)
			assert.strictEqual(
				JSON.stringify(markdownParser.lexer(source)),
				JSON.stringify(Lexer.lex(source, markdownParser.defaults)),
			);
	});

	it("does not rescan the remaining document for block math at every paragraph", () => {
		const paragraphs = (units: number) => "A short paragraph without math.\n\n".repeat(units);
		assertLinearScaling(paragraphs, 10_000, "block math lookup across paragraphs");
		const tokens = markdownParser.lexer(paragraphs(40_000));
		assert.equal(tokens.filter((token) => token.type === "paragraph").length, 40_000);
	});
});
