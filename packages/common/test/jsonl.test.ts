import { describe, expect, it } from "vitest";
import { jsonlLines, parseJsonlLine } from "../src/jsonl.ts";

describe("parseJsonlLine", () => {
	it("parses a record and tolerates a trailing carriage return", () => {
		expect(parseJsonlLine('{"a":1}\r')).toEqual({ ok: true, value: { a: 1 } });
		expect(parseJsonlLine("null")).toEqual({ ok: true, value: null });
	});

	it("returns undefined for a blank line and ok:false for a malformed one", () => {
		expect(parseJsonlLine("")).toBeUndefined();
		expect(parseJsonlLine(" \t")).toBeUndefined();
		expect(parseJsonlLine('{"a":')).toEqual({ ok: false });
	});
});

describe("jsonlLines", () => {
	it("yields every non-blank line in order and marks the malformed ones", () => {
		const text = '{"n":1}\n\n{torn\n[2]\n   \n3';
		expect([...jsonlLines(text)]).toEqual([
			{ ok: true, value: { n: 1 } },
			{ ok: false },
			{ ok: true, value: [2] },
			{ ok: true, value: 3 },
		]);
	});

	it("yields nothing for empty text", () => {
		expect([...jsonlLines("")]).toEqual([]);
		expect([...jsonlLines("\n\n")]).toEqual([]);
	});
});
