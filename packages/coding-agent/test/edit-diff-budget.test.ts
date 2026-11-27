import { describe, expect, it } from "vitest";
import { lineChanges } from "../src/core/tools/edit-diff/line-changes.ts";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";

describe("bounded preview diffs", () => {
	it("keeps precise context for ordinary edits", () => {
		expect(generateDiffString("one\ntwo\nthree\n", "one\nchanged\nthree\n")).toEqual({
			diff: " 1 one\n-2 two\n+2 changed\n 3 three",
			firstChangedLine: 2,
		});
	});

	it.each(["", "\n", "\r\n"])(
		"keeps both file versions exact when a large rewrite falls back (ending %j)",
		(ending) => {
			const oldMiddle = Array.from({ length: 1500 }, (_, i) => `old ${i}\n`).join("");
			const newMiddle = Array.from({ length: 1500 }, (_, i) => `new ${i}\n`).join("");
			const before = `shared\n${oldMiddle}tail${ending}`;
			const after = `shared\n${newMiddle}tail${ending}`;
			const parts = lineChanges(before, after);
			expect(
				parts
					.filter((part) => !part.added)
					.map((part) => part.value)
					.join(""),
			).toBe(before);
			expect(
				parts
					.filter((part) => !part.removed)
					.map((part) => part.value)
					.join(""),
			).toBe(after);
			expect(parts[0]).toMatchObject({ value: "shared\n", added: false, removed: false });
			expect(parts.at(-1)).toMatchObject({ value: `tail${ending}`, added: false, removed: false });
			expect(generateDiffString(before, after).firstChangedLine).toBe(2);
		},
	);
});
