import assert from "node:assert";
import { describe, it } from "node:test";
import { wrapTextWithAnsi } from "../src/utils/wrap.ts";
import { graphemeSegmenter, graphemeSegments, graphemeWidth, visibleWidth } from "../src/utils/width.ts";

// Characters next to which a grapheme break is or is not certain: CJK, kana and its combining sound mark, Hangul
// syllables and jamo, combining accents, ZWJ, emoji with variation selectors and skin tones, regional indicators, a
// Prepend sign, CR LF, fullwidth forms, the half fill space and ideographic variation selectors.
const ALPHABET = [
	"a",
	" ",
	"Z",
	"1",
	"#",
	"中",
	"文",
	"か",
	"\u3099",
	"カ",
	"\u302a",
	"한",
	"\u1100",
	"\u1161",
	"\u11a8",
	"\u0301",
	"\u200d",
	"\ufe0f",
	"\ufe0e",
	"😀",
	"👨",
	"👩",
	"🏽",
	"🇯",
	"🇵",
	"\u0600",
	"\r",
	"\n",
	"Ａ",
	"\u303f",
	"\u3000",
	"\u{e0100}",
	"\u20e3",
	"é",
	"\u0e33",
	"ก",
	"\u093f",
	"क",
];

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

function referenceSegments(text: string): string[] {
	return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function countSegmenterCalls(run: () => void): number {
	const segment = graphemeSegmenter.segment;
	let calls = 0;
	graphemeSegmenter.segment = (text: string) => {
		calls++;
		return segment.call(graphemeSegmenter, text);
	};
	try {
		run();
	} finally {
		graphemeSegmenter.segment = segment;
	}
	return calls;
}

describe("grapheme fast path", () => {
	it("splits and measures mixed text exactly as the segmenter does", () => {
		const next = random(7);
		for (let n = 0; n < 4000; n++) {
			const length = 1 + Math.floor(next() * 12);
			let text = "";
			for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
			const expected = referenceSegments(text);
			assert.deepStrictEqual([...graphemeSegments(text)], expected, JSON.stringify(text));
			const width = expected.reduce((sum, segment) => sum + graphemeWidth(segment), 0);
			assert.strictEqual(visibleWidth(text), width, JSON.stringify(text));
		}
	});

	it("measures every CJK, kana, Hangul syllable and fullwidth character as its grapheme width", () => {
		const ranges = [
			[0x3000, 0x30ff],
			[0x3400, 0x4dbf],
			[0x4e00, 0x9fff],
			[0xac00, 0xd7a3],
			[0xff00, 0xffef],
		];
		for (const [first, last] of ranges)
			for (let code = first; code <= last; code++) {
				const char = String.fromCharCode(code);
				assert.strictEqual(visibleWidth(char), graphemeWidth(char), `U+${code.toString(16)}`);
				assert.strictEqual(visibleWidth(`${char}中`), graphemeWidth(char) + 2, `U+${code.toString(16)} before 中`);
			}
	});

	it("wraps CJK rows without segmenting and emoji rows with a bounded number of segmenter calls", () => {
		const cjk = Array.from({ length: 500 }, (_, i) => `行${i} ` + "这是一个很长的中文句子用于测试宽度计算".repeat(3));
		assert.strictEqual(
			countSegmenterCalls(() => {
				for (const line of cjk) wrapTextWithAnsi(line, 37);
			}),
			0,
		);
		const emoji = Array.from({ length: 500 }, (_, i) => `🚀${i} ` + "😀 emoji 👨‍👩‍👧‍👦 mixed 🇯🇵 text ".repeat(4));
		const calls = countSegmenterCalls(() => {
			for (const line of emoji) wrapTextWithAnsi(line, 41);
		});
		assert.ok(calls < 50, `${calls} segmenter calls for 500 emoji rows`);
	});
});
