import { expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	type Edit,
} from "../src/core/tools/edit-diff.ts";
const all = (oldText: string, newText: string) =>
	({ oldText, newText, replaceAll: true }) as Edit;
it("replaces every non-overlapping original occurrence without recursion", () => {
	expect(
		applyEditsToNormalizedContent("aaa", [all("aa", "X")], "f").newContent,
	).toBe("Xa");
	expect(
		applyEditsToNormalizedContent("A A", [all("A", "AA")], "f").newContent,
	).toBe("AA AA");
});
it("keeps default and explicit false exact-once behavior", () => {
	for (const flag of [undefined, false])
		expect(() =>
			applyEditsToNormalizedContent(
				"A A",
				[{ oldText: "A", newText: "B", replaceAll: flag } as Edit],
				"f",
			),
		).toThrow(/unique/);
});
it("prefers exact occurrences over equivalent quotes", () => {
	expect(
		applyEditsToNormalizedContent('"A" “A” "A"', [all('"A"', "B")], "f")
			.newContent,
	).toBe("B “A” B");
});
it("uses quote fallback only when no exact occurrence exists", () => {
	expect(
		applyEditsToNormalizedContent("“A” “A”", [all('"A"', "B")], "f").newContent,
	).toBe("B B");
});
it("does not add trailing-whitespace or compatibility-normalization matches", () => {
	expect(() =>
		applyEditsToNormalizedContent("A  \nA  \n", [all("A\n", "B\n")], "f"),
	).toThrow(/find/);
	expect(() =>
		applyEditsToNormalizedContent("ﬀ ﬀ", [all("ff", "B")], "f"),
	).toThrow(/find/);
});
it("refuses mixed fuzzy edits rather than broadening exact all-occurrence matches", () => {
	expect(() =>
		applyEditsToNormalizedContent(
			'ﬀ\n"A" “A”',
			[all('"A"', "B"), { oldText: "ff", newText: "C" }],
			"f",
		),
	).toThrow(/Unsupported.*fuzzy/);
});
it("checks every expanded span for cross-edit overlap", () => {
	expect(() =>
		applyEditsToNormalizedContent(
			"AB AB",
			[all("AB", "X"), { oldText: "B AB", newText: "Y" }],
			"f",
		),
	).toThrow(/overlap/);
});

it("keeps original offsets across length-changing and quote-fallback all edits", () => {
	expect(
		applyEditsToNormalizedContent(
			"A “B” A “B” “C”",
			[all("A", "LONG"), all('"B"', "X")],
			"f",
		).newContent,
	).toBe("LONG X LONG X “C”");
});
