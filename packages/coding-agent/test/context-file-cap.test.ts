import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nestedContextFiles } from "../src/core/resource-loader/context-files.ts";

const MAX = 64 * 1024;
const dirs: string[] = [];
const project = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "context-cap-")));
	dirs.push(root);
	return root;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a nested instruction file at the size cap", () => {
	it.each([MAX, MAX + 1, MAX + 2])("keeps a %i-byte file within the cap, notice included", (size) => {
		const root = project();
		const sub = join(root, "pkg");
		mkdirSync(sub);
		writeFileSync(join(sub, "AGENTS.md"), "r".repeat(size));
		writeFileSync(join(sub, "a.ts"), "");
		const [loaded] = nestedContextFiles(join(sub, "a.ts"), root);
		expect(Buffer.byteLength(loaded.content)).toBeLessThanOrEqual(MAX);
		if (size > MAX) expect(loaded.content).toContain("truncated at 64 KiB");
		else expect(loaded.content).toBe("r".repeat(size));
	});

	it("serves a changed file's new text, not a stale copy", () => {
		const root = project();
		const sub = join(root, "pkg");
		mkdirSync(sub);
		writeFileSync(join(sub, "a.ts"), "");
		writeFileSync(join(sub, "AGENTS.md"), "one");
		expect(nestedContextFiles(join(sub, "a.ts"), root)[0].content).toBe("one");
		writeFileSync(join(sub, "AGENTS.md"), "two");
		utimesSync(join(sub, "AGENTS.md"), new Date(), new Date(Date.now() + 5000));
		expect(nestedContextFiles(join(sub, "a.ts"), root)[0].content).toBe("two");
	});
});
