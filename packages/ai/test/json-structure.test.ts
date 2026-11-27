import { describe, expect, it } from "vitest";
import { describeJsonStructure } from "../src/utils/json-structure.ts";

describe("describeJsonStructure", () => {
	it("names the closers a nested text still owes, innermost first", () => {
		expect(describeJsonStructure('{"queries":[{"edits":[{"a":"b"}')).toBe(
			"The text ends with 4 unclosed brackets; it needs `]}]}` at the end.",
		);
		expect(describeJsonStructure('{"a":[1,2')).toContain("2 unclosed brackets; it needs `]}`");
		expect(describeJsonStructure('{"a":1')).toContain("1 unclosed bracket; it needs `}`");
	});

	it("ignores brackets and escaped quotes inside strings", () => {
		expect(describeJsonStructure('{"a":"]}[{ \\" ]}"')).toContain("needs `}`");
	});

	it("reports a closer of the wrong kind with its position", () => {
		expect(describeJsonStructure('{"a":[1}')).toBe("Bracket mismatch: `}` at position 7 where `]` was expected.");
		expect(describeJsonStructure("]")).toBe("Bracket mismatch: `]` at position 0 where nothing more was expected.");
	});

	it("reports text that ends inside a string", () => {
		expect(describeJsonStructure('{"a":"cut')).toContain("ends inside a string");
	});

	it("has nothing to say about sound structure", () => {
		expect(describeJsonStructure('{"a":.5}')).toBeUndefined();
	});
});
