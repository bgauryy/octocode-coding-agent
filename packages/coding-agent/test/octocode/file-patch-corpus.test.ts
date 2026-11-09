import fs from "node:fs";
import { expect, it } from "vitest";
import { parsePatch, transformPatch } from "../../src/octocode/tool-input/codex-patch/patch.ts";
const corpus: {
	cases: Array<{ name: string; patch: string; source?: string; expected: any }>;
} = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-patch/corpus.json", import.meta.url), "utf8"));
it.each(corpus.cases)("matches pinned Rust patch oracle: $name", ({ patch, source, expected }) => {
	if (!expected.ok) {
		expect(() => parsePatch(patch)).toThrow();
		return;
	}
	const parsed = parsePatch(patch);
	expect(parsed.patch).toBe(expected.patch);
	expect(parsed.environment_id).toEqual(expected.environment_id);
	for (const [i, hunk] of parsed.hunks.entries()) {
		const { output, error, ...shape } = expected.hunks[i];
		expect(hunk).toEqual(shape);
		if (hunk.kind === "update" && source !== undefined) {
			if (error) expect(() => transformPatch(source, hunk.chunks)).toThrow();
			else expect(transformPatch(source, hunk.chunks)).toBe(output);
		}
	}
	expect(parsed.hunks.length).toBe(expected.hunks.length);
});
