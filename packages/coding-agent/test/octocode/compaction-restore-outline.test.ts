import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	RESTORE_FILE_CHARS,
	RESTORE_MAX_FILES,
	RESTORE_OUTLINE_CHARS,
	RESTORE_TOTAL_CHARS,
	restoreFiles,
} from "../../src/octocode/compaction/restore.ts";
import { tmp } from "./helpers.ts";

/** A TypeScript file of `count` functions with bodies of filler lines, longer than a whole file may be. */
function source(count: number, prefix = "work"): string {
	return Array.from(
		{ length: count },
		(_, i) =>
			`export function ${prefix}${i}(input: string): string {\n${"\tconst filler = input.repeat(2);\n".repeat(6)}\treturn filler;\n}\n`,
	).join("\n");
}

describe("file restore of a long file", () => {
	it("shows the outline of a file over the whole-file size, not its lines, and records it as partial", () => {
		const dir = tmp();
		const file = path.join(dir, "big.ts");
		const text = source(80);
		expect(text.length).toBeGreaterThan(RESTORE_FILE_CHARS);
		fs.writeFileSync(file, text);
		const restored = restoreFiles([{ file }], new Set(), dir)!;
		expect(restored.content).toContain("1: export function work0(input: string): string {");
		expect(restored.content).toMatch(/\[… outline only: \d+ of 80 declarations of a file of \d+ lines/);
		expect(restored.content).not.toContain("const filler");
		expect(restored.files[0]).toMatchObject({ file, whole: false });
		const outline = restored.content.slice(restored.content.indexOf("<file"));
		expect(outline.length).toBeLessThanOrEqual(RESTORE_OUTLINE_CHARS + 400);
	});

	it("marks the declaration holding the line last worked on, and shows rows around it when they do not all fit", () => {
		const dir = tmp();
		const file = path.join(dir, "big.ts");
		fs.writeFileSync(file, source(400));
		const line = 10 * 399 + 1;
		const restored = restoreFiles([{ file, line: line - 2 }], new Set(), dir)!;
		expect(restored.content).toMatch(new RegExp(`>${line - 10}: export function work398`));
	});

	it("keeps a file at or under the whole-file size whole", () => {
		const dir = tmp();
		const file = path.join(dir, "small.ts");
		const text = source(3);
		expect(text.length).toBeLessThanOrEqual(RESTORE_FILE_CHARS);
		fs.writeFileSync(file, text);
		const restored = restoreFiles([{ file }], new Set(), dir)!;
		expect(restored.content).toContain("const filler = input.repeat(2);");
		expect(restored.files[0]).toMatchObject({ file, whole: true });
		expect(restored.content).not.toContain("outline only");
	});

	it("outlines Markdown headings", () => {
		const dir = tmp();
		const file = path.join(dir, "guide.md");
		fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => `# Part ${i}\n${"prose line ".repeat(5)}\n`).join(""));
		const restored = restoreFiles([{ file }], new Set(), dir)!;
		expect(restored.content).toContain("1: # Part 0");
		expect(restored.content).not.toContain("prose line");
	});

	it("falls back to a window of lines when a long file has no declaration to list", () => {
		const dir = tmp();
		const file = path.join(dir, "data.txt");
		fs.writeFileSync(file, "12345 67890 12345\n".repeat(1_000));
		const restored = restoreFiles([{ file }], new Set(), dir)!;
		expect(restored.content).toMatch(/\[… shown lines 1–\d+ of 1000;/);
		expect(restored.content).not.toContain("outline only");
	});

	it("keeps the total of five long files within the lowered cap", () => {
		const dir = tmp();
		const files = Array.from({ length: RESTORE_MAX_FILES + 1 }, (_, i) => path.join(dir, `f${i}.ts`));
		files.forEach((file, i) => fs.writeFileSync(file, source(80, `w${i}x`)));
		const restored = restoreFiles(
			files.map((file) => ({ file })),
			new Set(),
			dir,
		)!;
		expect(RESTORE_TOTAL_CHARS).toBeLessThanOrEqual(20_000);
		expect(restored.content.length).toBeLessThanOrEqual(RESTORE_TOTAL_CHARS);
		expect(restored.files.length).toBeGreaterThan(1);
		expect(restored.files.every((entry) => !entry.whole)).toBe(true);
	});
});
