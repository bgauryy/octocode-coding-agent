import assert from "node:assert";
import { describe, it } from "node:test";
import { ansiCodeLength, extractAnsiCode, incompleteAnsiStart } from "../src/utils/ansi-codes.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { truncateToWidth } from "../src/utils/truncate.ts";
import { visibleWidth } from "../src/utils/width.ts";
import { wrapTextWithAnsi } from "../src/utils/wrap.ts";

/** Non-SGR CSI sequences: cursor show/hide, cursor moves, erase, private modes, intermediates. */
const NON_SGR_CSI = [
	"\x1b[?25l",
	"\x1b[?25h",
	"\x1b[3C",
	"\x1b[2A",
	"\x1b[10;20H",
	"\x1b[2K",
	"\x1b[0J",
	"\x1b[?1049h",
	"\x1b[?2004l",
	"\x1b[>4;2m",
	"\x1b[1;5r",
	"\x1b[0 q",
	"\x1b[6n",
];

describe("CSI grammar (ECMA-48)", () => {
	it("measures a CSI from ESC [ through its final byte", () => {
		for (const code of NON_SGR_CSI) assert.strictEqual(ansiCodeLength(code, 0), code.length, JSON.stringify(code));
		assert.strictEqual(extractAnsiCode(`x${NON_SGR_CSI[0]}y`, 1)?.code, NON_SGR_CSI[0]);
	});

	it("ends at the first final byte, not at a later m/G/K/H/J", () => {
		assert.strictEqual(ansiCodeLength("\x1b[3Cabc", 0), 4);
		assert.strictEqual(ansiCodeLength("\x1b[?25lHello", 0), 6);
	});

	it("is not a CSI when a byte outside the grammar precedes the final byte", () => {
		assert.strictEqual(ansiCodeLength("\x1b[31", 0), 0); // no final byte
		assert.strictEqual(ansiCodeLength("\x1b[3\x01m", 0), 0); // control byte
		assert.strictEqual(ansiCodeLength("\x1b[3 1m", 0), 0); // parameter byte after intermediate
		assert.strictEqual(ansiCodeLength("\x1b[3\u00e9m", 0), 0); // non-ASCII
		assert.strictEqual(ansiCodeLength("\x1b[", 0), 0);
	});

	it("keeps the stripped text for non-SGR CSI", () => {
		for (const code of NON_SGR_CSI) assert.strictEqual(stripTerminalSequences(`a${code}b`), "ab");
	});

	describe("8-bit C1 controls", () => {
		it("strips C1 CSI, OSC, DCS, SOS, PM and APC sequences", () => {
			assert.strictEqual(stripTerminalSequences("a\x9b31mred\x9b0mz"), "aredz");
			assert.strictEqual(stripTerminalSequences("a\x9b?25lb"), "ab");
			assert.strictEqual(stripTerminalSequences("a\x9d8;;https://example.com\x07link\x9d8;;\x07z"), "alinkz");
			assert.strictEqual(stripTerminalSequences("a\x9d0;title\x9cz"), "az");
			assert.strictEqual(stripTerminalSequences("a\x9dh\x1b\\z"), "az");
			assert.strictEqual(stripTerminalSequences("a\x90abc\x9cz"), "az");
			assert.strictEqual(stripTerminalSequences("a\x98x\x9cb\x9ey\x9cc\x9fz\x9cd"), "abcd");
		});

		it("ends an ESC-introduced string sequence at the C1 string terminator", () => {
			assert.strictEqual(stripTerminalSequences("a\x1b]0;title\x9cz"), "az");
			assert.strictEqual(stripTerminalSequences("a\x1bPabc\x9cz"), "az");
		});

		it("keeps text after an unfinished or malformed C1 sequence", () => {
			assert.strictEqual(stripTerminalSequences("a\x9b31"), "a\x9b31");
			assert.strictEqual(stripTerminalSequences("a\x9dunterminated"), "a\x9dunterminated");
			assert.strictEqual(stripTerminalSequences("a\x9b3\x01mb"), "a\x9b3\x01mb");
		});

		it("leaves width measurement to ESC-introduced sequences", () => {
			assert.strictEqual(ansiCodeLength("\x9b31m", 0), 0);
			assert.strictEqual(ansiCodeLength("\x1b]0;t\x9cz", 0), 0);
		});

		it("reports an unfinished C1 sequence at the end for streaming splits", () => {
			assert.strictEqual(incompleteAnsiStart("abc\x9b3"), 3);
			assert.strictEqual(incompleteAnsiStart("abc\x9d0;t"), 3);
			assert.strictEqual(incompleteAnsiStart("abc\x9b3mz"), -1);
		});
	});

	describe("visibleWidth", () => {
		it("ignores non-SGR CSI", () => {
			assert.strictEqual(visibleWidth("\x1b[?25lHello"), 5);
			assert.strictEqual(visibleWidth("\x1b[3Cabc"), 3);
			assert.strictEqual(visibleWidth("\x1b[2Kabc\x1b[?25h"), 3);
			assert.strictEqual(visibleWidth("\x1b[?1049hhi\x1b[?1049l"), 2);
			for (const code of NON_SGR_CSI) assert.strictEqual(visibleWidth(`ab${code}cd`), 4, JSON.stringify(code));
		});

		it("counts an invalid CSI as visible characters", () => {
			assert.strictEqual(visibleWidth("\x1b[31"), 3);
		});
	});

	describe("truncateToWidth", () => {
		it("neither counts nor cuts non-SGR CSI", () => {
			const text = `\x1b[?25l${"x".repeat(10)}\x1b[3C`;
			assert.strictEqual(truncateToWidth(text, 10), text);
			const cut = truncateToWidth(`\x1b[?25l${"x".repeat(20)}`, 8);
			assert.strictEqual(visibleWidth(cut), 8);
			assert.ok(cut.startsWith("\x1b[?25l"));
		});

		it("returns text that fits unchanged when it holds a cursor move", () => {
			assert.strictEqual(truncateToWidth("\x1b[3Cabc", 3), "\x1b[3Cabc");
		});
	});

	describe("wrapTextWithAnsi", () => {
		it("wraps by visible width with non-SGR CSI inside", () => {
			const text = "\x1b[?25lhello \x1b[3Cworld\x1b[?25h";
			assert.deepStrictEqual(wrapTextWithAnsi(text, 11), [text]);
			const lines = wrapTextWithAnsi(`\x1b[?25l${"ab ".repeat(10)}`, 10);
			assert.ok(lines.length > 1);
			for (const line of lines) assert.ok(visibleWidth(line) <= 10, JSON.stringify(line));
			assert.strictEqual(stripTerminalSequences(lines.join(" ")).replace(/\s+/g, " ").trim(), "ab ".repeat(10).trim());
		});
	});
});
