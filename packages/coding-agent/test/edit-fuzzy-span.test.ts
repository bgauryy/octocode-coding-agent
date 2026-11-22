import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	applyReplacementsToOriginal,
	normalizeToLF,
} from "../src/core/tools/edit-diff.ts";
import { applyEdit, applyWrite, type ChangeOperations } from "../src/octocode/files/tool/apply.ts";

/** Fuzzy matching only finds the span; every byte outside it stays as in the file. */

function edit(original: string, oldText: string, newText: string): string {
	const text = normalizeToLF(original);
	const { replacements } = applyEditsToNormalizedContent(text, [{ oldText, newText }], "f.ts");
	return applyReplacementsToOriginal(original, replacements);
}

describe("fuzzy edit keeps bytes outside the match", () => {
	it("does not normalize the rest of the line", () => {
		const original = 'const s = "x²™"; // “quote”   \nnext\n';
		expect(edit(original, '// "quote"', "// done")).toBe('const s = "x²™"; // done   \nnext\n');
	});

	it("keeps trailing whitespace of untouched lines and tolerates it in oldText", () => {
		expect(edit("a  \nb \nc\n", "a\nb", "X")).toBe("X \nc\n");
	});

	it("matches NBSP and dashes, keeping the neighbours", () => {
		expect(edit("p\u00a0q – r\u00a0s\n", "q - r", "Q")).toBe("p\u00a0Q\u00a0s\n".replace("\u00a0Q", "\u00a0Q"));
	});

	it("keeps CRLF and BOM-free bytes", () => {
		expect(edit("“a”\r\n“b”\r\n", '"b"', "B")).toBe("“a”\r\nB\r\n");
	});

	it("still refuses duplicates and missing text", () => {
		expect(() => applyEditsToNormalizedContent("“a” “a”\n", [{ oldText: '"a"', newText: "b" }], "f")).toThrow(
			/2 occurrences/,
		);
		expect(() => applyEditsToNormalizedContent("abc\n", [{ oldText: "zzz", newText: "b" }], "f")).toThrow(
			/Could not find/,
		);
	});
});

describe("committed write survives a late abort", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reports an edit and a write as done when the abort lands after the commit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "edit-abort-"));
		dirs.push(dir);
		const file = join(dir, "a.txt");
		writeFileSync(file, "one\n");
		const controller = new AbortController();
		const ops: ChangeOperations = {
			readFile: async (p) => readFileSync(p),
			writeFile: async (p, content) => {
				writeFileSync(p, content);
				controller.abort();
			},
			access: async () => {},
			mkdir: async () => {},
		};
		const edited = await applyEdit(file, file, [{ oldText: "one", newText: "two" }], ops, controller.signal);
		expect(edited.message).toMatch(/Successfully replaced/);
		expect(readFileSync(file, "utf8")).toBe("two\n");
		const wrote = await applyWrite(file, file, "three\n", ops, controller.signal).catch((error: Error) => error);
		// The signal was already aborted before the write began: nothing is written.
		expect(wrote).toBeInstanceOf(Error);
		expect(readFileSync(file, "utf8")).toBe("two\n");
		const fresh = new AbortController();
		const written = await applyWrite(
			file,
			file,
			"four\n",
			{
				...ops,
				writeFile: async (p, c) => {
					writeFileSync(p, c);
					fresh.abort();
				},
			},
			fresh.signal,
		);
		expect(written.message).toMatch(/Successfully wrote/);
		expect(readFileSync(file, "utf8")).toBe("four\n");
	});
});

describe("whitespace-only edits", () => {
	it("removes trailing spaces that normalization erases", () => {
		expect(edit("foo  \nfoo\n", "foo  ", "foo")).toBe("foo\nfoo\n");
	});

	it("changes indentation only", () => {
		expect(edit("a\n\tb\n", "\tb", "    b")).toBe("a\n    b\n");
	});

	it("edits a whitespace-only span", () => {
		expect(edit("a\n\n\nb\n", "\n\n\n", "\n\n")).toBe("a\n\nb\n");
	});
});
