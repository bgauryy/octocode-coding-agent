import { expect, it } from "vitest";
import { parsePatch, transformPatch } from "../../src/octocode/shared/codex-patch/patch.ts";

it("matches a hunk past a long run of whitespace in linear time, as Rust's trim does", () => {
	// A line whose whitespace run is followed by text made the `\s+$` trim backtrack quadratically.
	const wide = `${" ".repeat(60_000)}x`;
	const source = `${wide}\nfoo \n`;
	const [hunk] = parsePatch(
		["*** Begin Patch", "*** Update File: a.txt", "@@", `-foo`, "+bar", "*** End Patch"].join("\n"),
	).hunks;
	if (hunk.kind !== "update") throw new Error("expected an update hunk");
	const started = performance.now();
	// `foo` matches `foo ` only on the trimEnd pass, which normalises the wide line first.
	expect(transformPatch(source, hunk.chunks)).toBe(`${wide}\nbar\n`);
	expect(performance.now() - started).toBeLessThan(1_000);
}, 30_000);

it("trims the Unicode whitespace Rust's str::trim trims, and nothing else", () => {
	const [hunk] = parsePatch(
		["*** Begin Patch", "*** Update File: a.txt", "@@", "-\u3000foo\u2028\u0085", "+bar", "*** End Patch"].join("\n"),
	).hunks;
	if (hunk.kind !== "update") throw new Error("expected an update hunk");
	expect(transformPatch("\u00a0foo\t\n", hunk.chunks)).toBe("bar\n");
	// U+200B (zero-width space) is not White_Space, so it is not trimmed and the line does not match.
	expect(() => transformPatch("\u200bfoo\n", hunk.chunks)).toThrow(/expected lines not found/);
}, 30_000);
