import { describe, expect, it } from "vitest";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../src/utils/ansi.ts";

function referenceAnsiRegex(): RegExp {
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
	return new RegExp(`${osc}|${csi}`, "g");
}

const referenceRegex = referenceAnsiRegex();

function referenceStripAnsi(value: string): string {
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}
	return value.replace(referenceRegex, "");
}

/** Well-formed sequences: the ECMA-48 grammar in the TUI scanner and chalk's strip-ansi agree on these. */
const WELL_FORMED_INPUTS = [
	"plain",
	"a\x1b[31mred\x1b[0mz",
	"a\x1b[38;5;240mgrey\x1b[39mz",
	"a\x1b[38:2::1:2:3mcolon\x1b[0mz",
	"a\x1b[2Kb\x1b[1;1Hc\x1b[2Jd",
	"a\x1b[?25lb\x1b[?25hc",
	"a\x1b[3Cb",
	"a\x1b]8;;https://example.com\x07link\x1b]8;;\x07z",
	"a\x1b]0;title\x1b\\z",
	"a\x1bcok",
	"a\x1b(0x",
];

describe("stripAnsi", () => {
	it("matches chalk strip-ansi for well-formed sequences", () => {
		for (const input of WELL_FORMED_INPUTS) {
			expect(stripAnsi(input)).toBe(referenceStripAnsi(input));
		}
	});

	it("strips non-SGR CSI whole, including parameter and intermediate bytes", () => {
		expect(stripAnsi("\x1b[?25lHello")).toBe("Hello");
		expect(stripAnsi("\x1b[3Cabc")).toBe("abc");
		expect(stripAnsi("a\x1b[0 qb\x1b[>4;2mc\x1b[6nd")).toBe("abcd");
	});

	it("keeps text after a malformed or unfinished sequence", () => {
		expect(stripAnsi("a\x1b]unterminated")).toBe("a\x1b]unterminated");
		expect(stripAnsi("a\x1b[31")).toBe("a\x1b[31");
		expect(stripAnsi("a\x1b[3\x01mb")).toBe("a\x1b[3\x01mb");
		expect(stripAnsi("a\x1b")).toBe("a\x1b");
	});

	it("strips DCS strings up to ST", () => {
		expect(stripAnsi("a\x1bPabc\x1b\\z")).toBe("az");
	});

	it("throws the same TypeError as chalk strip-ansi for non-string values", () => {
		const stripAnsiUnknown = stripAnsi as (value: unknown) => string;

		for (const value of [undefined, null, 123, {}, Object("x")]) {
			const message = `Expected a \`string\`, got \`${typeof value}\``;
			expect(() => stripAnsiUnknown(value)).toThrow(TypeError);
			expect(() => stripAnsiUnknown(value)).toThrow(message);
		}
	});

	it("strips 8-bit C1 sequences like chalk strip-ansi", () => {
		expect(stripAnsi("a\x9b31mred\x9b0mz")).toBe(referenceStripAnsi("a\x9b31mred\x9b0mz"));
		expect(stripAnsi("a\x9b31mred\x9b0mz")).toBe("aredz");
		expect(stripAnsi("a\x1b]0;title\x9cz")).toBe(referenceStripAnsi("a\x1b]0;title\x9cz"));
		expect(stripAnsi("a\x9d8;;https://example.com\x07link\x9d8;;\x07z")).toBe("alinkz");
	});

	it("strips RIS without leaking the final byte", () => {
		expect(stripAnsi("\x1bcdone")).toBe("done");
	});

	it("strips single-byte ESC sequences without leaking final bytes", () => {
		for (let code = "g".charCodeAt(0); code <= "m".charCodeAt(0); code++) {
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
		for (let code = "r".charCodeAt(0); code <= "t".charCodeAt(0); code++) {
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
	});

	it("strips common ANSI sequences used in tool output", () => {
		const input = "a\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07z";
		expect(stripAnsi(input)).toBe("aredlinkz");
	});
});

describe("splitIncompleteAnsiSuffix", () => {
	it("holds back an unfinished CSI, OSC or lone ESC at the end", () => {
		expect(splitIncompleteAnsiSuffix("abc\x1b[3")).toEqual({ complete: "abc", pending: "\x1b[3" });
		expect(splitIncompleteAnsiSuffix("abc\x1b[?25")).toEqual({ complete: "abc", pending: "\x1b[?25" });
		expect(splitIncompleteAnsiSuffix("abc\x1b]8;;http")).toEqual({ complete: "abc", pending: "\x1b]8;;http" });
		expect(splitIncompleteAnsiSuffix("abc\x1b")).toEqual({ complete: "abc", pending: "\x1b" });
		expect(splitIncompleteAnsiSuffix("abc\x1b]0;t\x1b")).toEqual({ complete: "abc", pending: "\x1b]0;t\x1b" });
	});

	it("passes complete text through", () => {
		for (const text of ["abc", "a\x1b[31mb", "a\x1b]8;;u\x07b", "a\x1b]0;t\x1b\\", "a\x1b[3Cb"]) {
			expect(splitIncompleteAnsiSuffix(text)).toEqual({ complete: text, pending: "" });
		}
	});

	it("holds back an unfinished 8-bit C1 sequence", () => {
		expect(splitIncompleteAnsiSuffix("abc\x9b3")).toEqual({ complete: "abc", pending: "\x9b3" });
		expect(splitIncompleteAnsiSuffix("abc\x9d0;t")).toEqual({ complete: "abc", pending: "\x9d0;t" });
		expect(splitIncompleteAnsiSuffix("a\x9b31mb")).toEqual({ complete: "a\x9b31mb", pending: "" });
	});

	it("reassembles a sequence split across chunks", () => {
		const first = splitIncompleteAnsiSuffix("ab\x1b[?2");
		const second = splitIncompleteAnsiSuffix(`${first.pending}5lcd`);
		expect(stripAnsi(first.complete + second.complete)).toBe("abcd");
		expect(second.pending).toBe("");
	});
});
