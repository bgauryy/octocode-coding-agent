import { beforeAll, describe, expect, it } from "vitest";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
/** Background SGR sequences (`48;…`) in a line. */
const backgrounds = (text: string) => text.match(/\x1b\[48;[0-9;]*m/g) ?? [];

const BEFORE = "function greet(name) {\n\treturn 'Hello ' + name;\n}\n";
const AFTER = "function greet(name, punct) {\n\treturn 'Hello ' + name + punct;\n}\n";

describe("renderDiff", () => {
	describe("on a theme without tool backgrounds", () => {
		beforeAll(() => initTheme("octocode-dark"));

		it("keeps the text of every line", () => {
			const { diff } = generateDiffString(BEFORE, AFTER);
			expect(renderDiff(diff, { filePath: "greet.js" }).split("\n").map(plain)).toEqual(
				diff.split("\n").map((line) => line.replace(/\t/g, "   ")),
			);
		});

		it("tints changed lines and marks changed words with a stronger tint", () => {
			const { diff } = generateDiffString(BEFORE, AFTER);
			const lines = renderDiff(diff, { filePath: "greet.js" }).split("\n");
			const added = lines.find((line) => plain(line).startsWith("+") && plain(line).includes("punct)"))!;
			const tints = new Set(backgrounds(added));
			// The line tint plus the word tint.
			expect(tints.size).toBe(2);
			expect(added.endsWith("\x1b[49m")).toBe(true);
			const context = lines.find((line) => plain(line).startsWith(" "))!;
			expect(backgrounds(context)).toEqual([]);
		});

		it("emphasizes whole changed words only", () => {
			const { diff } = generateDiffString("let total = 0;\n", "let sum = 0;\n");
			const added = renderDiff(diff)
				.split("\n")
				.find((line) => plain(line).startsWith("+"))!;
			const [, wordTint] = [...new Set(backgrounds(added))];
			const start = added.indexOf(wordTint!) + wordTint!.length;
			const emphasized = plain(added.slice(start, added.indexOf("\x1b[48;", start)));
			expect(emphasized).toBe("sum");
		});

		it("does not mark words in a rewritten line", () => {
			const { diff } = generateDiffString("for (const v of values) total += v;\n", "return values.length;\n");
			for (const line of renderDiff(diff)
				.split("\n")
				.filter((row) => /^[+-]/.test(plain(row))))
				expect(new Set(backgrounds(line)).size).toBe(1);
		});
	});

	describe("on a theme that draws tool backgrounds", () => {
		beforeAll(() => initTheme("dark"));

		it("keeps the foreground-only rendering", () => {
			const { diff } = generateDiffString(BEFORE, AFTER);
			const rendered = renderDiff(diff, { filePath: "greet.js" });
			expect(backgrounds(rendered)).toEqual([]);
			expect(rendered.split("\n").map(plain)).toEqual(diff.split("\n").map((line) => line.replace(/\t/g, "   ")));
		});
	});
});
