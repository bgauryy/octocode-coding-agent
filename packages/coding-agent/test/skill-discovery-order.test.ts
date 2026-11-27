import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as FsModule from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

// A file system may list a directory in any order: this one lists it in reverse.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof FsModule>();
	return {
		...fs,
		readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
			const entries = fs.readdirSync(...args);
			return Array.isArray(entries) ? [...entries].reverse() : entries;
		}) as typeof fs.readdirSync,
	};
});

const { loadSkillsFromDir } = await import("../src/core/skills.ts");

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("lists skills by directory name whatever order the file system returns them in", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-skill-order-")));
	roots.push(root);
	for (const name of ["delta", "alpha", "charlie", "bravo"]) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture\n---\nBody`);
	}
	expect(loadSkillsFromDir({ dir: root, source: "test" }).skills.map((skill) => skill.name)).toEqual([
		"alpha",
		"bravo",
		"charlie",
		"delta",
	]);
});
