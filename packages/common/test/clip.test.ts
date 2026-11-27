import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clip, clipText } from "../src/clip.ts";

describe("clip", () => {
	it("keeps ASCII rules", () => {
		expect(clipText("abcdef", 4)).toBe("abc…");
		expect(clipText("abcd", 4)).toBe("abcd");
		expect(clipText("abc", 0)).toBe("");
		expect(clip("  a\tb\nc ", 10)).toBe("a b");
	});

	it("never splits a grapheme and drops one that does not fit whole", () => {
		const family = "👨‍👩‍👧‍👦";
		expect(family.length).toBe(11);
		expect(clipText(`${family}${family}${family}`, 12)).toBe(`${family}…`);
		expect(clipText(`${family}${family}`, 11)).toBe("…");
		expect(clipText("🇩🇪🇫🇷🇯🇵", 5)).toBe("🇩🇪…");
		expect(clipText("🇩🇪🇫🇷🇯🇵", 7)).toBe("🇩🇪…");
		expect(clipText("e\u0301e\u0301e\u0301", 3)).toBe("e\u0301…");
		expect(clipText("e\u0301e\u0301e\u0301", 2)).toBe("…");
		expect(clipText("abe\u0301", 3)).toBe("ab…");
	});

	it("never returns more code units than the limit", () => {
		const stacked = `a${"\u0301".repeat(1000)}b`;
		for (const max of [1, 2, 10, 500]) expect(clipText(stacked, max).length).toBeLessThanOrEqual(max);
		expect(clipText("ab😀cd", 4)).toBe("ab…");
	});

	it("makes its segmenter only when a cut needs one", () => {
		const source = fileURLToPath(new URL("../src/clip.ts", import.meta.url));
		const script = `
			let made = 0;
			const Real = Intl.Segmenter;
			Intl.Segmenter = class extends Real { constructor(...args) { super(...args); made++; } };
			const { clipText } = await import(${JSON.stringify(source)});
			const counts = [made];
			clipText("abcdef", 4);
			counts.push(made);
			clipText("e\\u0301e\\u0301e\\u0301", 3);
			clipText("\\u{1F600}\\u{1F600}\\u{1F600}", 3);
			counts.push(made);
			console.log(counts.join(","));
		`;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		expect(output.trim()).toBe("0,0,1");
	});
});
