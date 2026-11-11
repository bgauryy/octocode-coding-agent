import { beforeAll, describe, expect, it } from "vitest";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { renderDiff } from "../src/theme/diff.ts";
import { initTheme } from "../src/theme/theme.ts";

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
			const start = added.indexOf(wordTint) + wordTint.length;
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

		it("preserves long rewritten lines with line tint when word emphasis is skipped", () => {
			const old = Array.from({ length: 3000 }, (_, i) => `old${i}`).join(" ");
			const next = Array.from({ length: 3000 }, (_, i) => `new${i}`).join(" ");
			const { diff } = generateDiffString(old, next);
			const rendered = renderDiff(diff).split("\n");
			expect(rendered.map(plain)).toEqual(diff.split("\n"));
			for (const line of rendered) expect(new Set(backgrounds(line)).size).toBe(1);
		});
	});

	describe("syntax colour", () => {
		const OLD = "/* first\n second\n third */\nconst a = 1;\n";
		const NEW = "const a = 2;\n";
		const colour = (line: string) => line.match(/\x1b\[38;[0-9;]*m/)?.[0];

		for (const themeName of ["octocode-dark", "dark"]) {
			it(`colours every line of a comment spanning removed lines (${themeName})`, () => {
				initTheme(themeName);
				const { diff } = generateDiffString(OLD, NEW);
				const removed = renderDiff(diff, { filePath: "a.ts" })
					.split("\n")
					.filter((line) => plain(line).startsWith("-"));
				expect(removed.map((line) => plain(line).replace(/^-\s*\d+ /, ""))).toEqual([
					"/* first",
					" second",
					" third */",
					"const a = 1;",
				]);
				// Skip the sign colour: the body's first colour is the comment colour on all three comment lines.
				const bodyColour = (line: string) => colour(line.slice(line.indexOf(" ") + 1));
				expect(bodyColour(removed[1])).toBeDefined();
				expect(bodyColour(removed[1])).toBe(bodyColour(removed[0]));
				expect(bodyColour(removed[2])).toBe(bodyColour(removed[0]));
				expect(bodyColour(removed[3])).not.toBe(bodyColour(removed[0]));
			});
		}

		it("keeps word emphasis over highlighted text and dims syntax on context lines", () => {
			initTheme("octocode-dark");
			const { diff } = generateDiffString(
				"const a = 1;\nconst b = 2;\nconst c = 3;\n",
				"const a = 1;\nconst b = 5;\nconst c = 3;\n",
			);
			const lines = renderDiff(diff, { filePath: "a.ts" }).split("\n");
			const added = lines.find((line) => plain(line).startsWith("+"))!;
			expect(new Set(backgrounds(added)).size).toBe(2);
			const context = lines.find((line) => plain(line).startsWith(" "))!;
			expect(context).toContain("\x1b[2m");
			expect(colour(context.slice(context.indexOf("\x1b[2m")))).toBeDefined();
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
