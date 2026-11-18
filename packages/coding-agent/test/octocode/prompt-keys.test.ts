import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getNativeDir } from "../../src/config.ts";
import { PROMPT_FOLDERS, promptSource } from "../../src/core/prompt-template.ts";

const src = fileURLToPath(new URL("../../src/", import.meta.url));

function filesUnder(root: string, ext: string): string[] {
	return fs
		.readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(ext))
		.map((entry) => path.join(entry.parentPath, entry.name));
}

describe("prompt keys", () => {
	it("resolves every literal renderPrompt/promptSource name in the source", () => {
		const names = new Set<string>();
		for (const file of filesUnder(src, ".ts"))
			for (const match of fs.readFileSync(file, "utf8").matchAll(/\b(?:renderPrompt|promptSource)\(\s*"([^"]+\.md)"/g))
				names.add(match[1]);
		expect(names.size).toBeGreaterThan(50);
		const missing = [...names].filter((name) => {
			try {
				promptSource(name);
				return false;
			} catch {
				return true;
			}
		});
		expect(missing).toEqual([]);
	});

	it("resolves every {{> include}} in the prompt folders", () => {
		const includes = new Set<string>();
		for (const folder of Object.keys(PROMPT_FOLDERS))
			for (const file of filesUnder(path.join(getNativeDir(), folder), ".md").filter(
				(file) => !file.endsWith("README.md"),
			))
				for (const match of fs.readFileSync(file, "utf8").matchAll(/\{\{>\s*([^}\s]+)\s*\}\}/g)) includes.add(match[1]);
		expect(includes.size).toBeGreaterThan(5);
		for (const name of includes) expect(() => promptSource(name), name).not.toThrow();
	});

	it("refuses a name no prompt folder holds", () => {
		expect(() => promptSource("skills/octocode-debugging/SKILL.md")).toThrow(/Prompt template: no file/);
		expect(() => promptSource("final/main.md")).toThrow(/Prompt template: no file/);
	});
});
