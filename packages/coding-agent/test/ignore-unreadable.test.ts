import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { addIgnoreRules } from "../src/utils/ignore.ts";

describe("addIgnoreRules", () => {
	it("reads the rules it can and names the file it cannot", () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-ignore-"));
		writeFileSync(join(dir, ".ignore"), "secret.txt\n");
		// A directory under the name stands in for a file that cannot be read, on every platform and as any user.
		mkdirSync(join(dir, ".gitignore"));
		const unreadable: string[] = [];
		const matcher = ignore();
		addIgnoreRules(matcher, dir, dir, (file) => unreadable.push(file));
		expect(unreadable).toEqual([join(dir, ".gitignore")]);
		expect(matcher.ignores("secret.txt")).toBe(true);
	});

	it("still does not throw without a listener", () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-ignore-"));
		mkdirSync(join(dir, ".gitignore"));
		expect(() => addIgnoreRules(ignore(), dir, dir)).not.toThrow();
	});
});
