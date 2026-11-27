import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.ts";
import { formatAnchor, isEvidenceRead, isSourceAnchor, parseAnchor, type SourceAnchor } from "../src/evidence.ts";

const anchors: SourceAnchor[] = [
	{ kind: "archive", sessionId: "s1", segment: 2, entryId: "ab12cd34" },
	{ kind: "archive", sessionId: "we/ird:id", segment: 10, entryId: "e 1" },
	{ kind: "transcript", sessionId: "s1", entryId: "ab12cd34" },
];

describe("SourceAnchor", () => {
	it("is exported from the index", () => {
		expect(contracts.parseAnchor).toBe(parseAnchor);
	});

	it.each(anchors)("round-trips %j through its string form", (anchor) => {
		expect(isSourceAnchor(anchor)).toBe(true);
		expect(parseAnchor(formatAnchor(anchor))).toEqual(anchor);
	});

	it("formats the documented shapes", () => {
		expect(formatAnchor(anchors[0])).toBe("archive:s1/2/ab12cd34");
		expect(formatAnchor(anchors[2])).toBe("transcript:s1/ab12cd34");
	});

	it.each([
		"",
		"archive",
		"archive:s1/2",
		"archive:s1/0/e",
		"archive:s1/x/e",
		"archive:s1/2/e/extra",
		"archive://2/e",
		"memory:M1",
		"__proto__:a/b",
		"transcript:s1",
		"archive:%E0%A4%A/1/e",
	])("rejects %j", (text) => {
		expect(parseAnchor(text)).toBeUndefined();
	});

	it("rejects unknown kinds and extra fields as values", () => {
		expect(isSourceAnchor({ kind: "memory", id: "M1" })).toBe(false);
		expect(isSourceAnchor({ ...anchors[0], extra: 1 })).toBe(false);
	});
});

describe("EvidenceRead", () => {
	it("accepts present and missing reads", () => {
		expect(isEvidenceRead({ anchor: anchors[0], availability: "missing" })).toBe(true);
		expect(
			isEvidenceRead({
				anchor: anchors[0],
				availability: "present",
				author: "user",
				text: "x",
				truncated: true,
				nextCursor: "c",
			}),
		).toBe(true);
	});
	it("rejects an unknown availability", () => {
		expect(isEvidenceRead({ anchor: anchors[0], availability: "stale" })).toBe(false);
	});
});
