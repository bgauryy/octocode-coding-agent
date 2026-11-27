import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { PROMPT_PACK, readPromptSources } from "../src/core/prompt-template.ts";

const sourceNative = join(import.meta.dirname, "..", "src", "octocode", "native");
/** The build step that copies `native/` and writes the pack. */
const copyNative = join(import.meta.dirname, "..", "..", "..", "scripts", "build", "copy-native.mjs");
const root = mkdtempSync(join(tmpdir(), "prompt-pack-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("packed prompts", () => {
	test("a build's pack gives every prompt the source folders give, byte for byte", () => {
		const built = join(root, "built");
		execFileSync(process.execPath, [copyNative, sourceNative, built]);
		const fromSource = readPromptSources(sourceNative);
		expect(fromSource.size).toBeGreaterThan(100);
		const packed = JSON.parse(readFileSync(join(built, PROMPT_PACK), "utf8")) as Record<string, string>;
		// Only the pack: the copied folders are gone, so nothing below can come from them.
		const packOnly = join(root, "pack-only");
		mkdirSync(packOnly);
		writeFileSync(join(packOnly, PROMPT_PACK), JSON.stringify(packed));
		expect(Object.fromEntries(readPromptSources(packOnly))).toEqual(Object.fromEntries(fromSource));
	});

	test("the pack wins over the files beside it, and a folder without one reads the files", () => {
		const native = join(root, "both");
		mkdirSync(join(native, "prompts", "policy"), { recursive: true });
		mkdirSync(join(native, "tools", "bash"), { recursive: true });
		writeFileSync(join(native, "prompts", "policy", "finish.md"), "from file\n");
		writeFileSync(join(native, "prompts", "README.md"), "map\n");
		writeFileSync(join(native, "tools", "bash", "cli.md"), "cli\n");
		expect(Object.fromEntries(readPromptSources(native))).toEqual({
			"policy/finish.md": "from file\n",
			"tools/bash/cli.md": "cli\n",
		});
		writeFileSync(join(native, PROMPT_PACK), JSON.stringify({ "prompts/policy/finish.md": "from pack\n" }));
		expect(Object.fromEntries(readPromptSources(native))).toEqual({ "policy/finish.md": "from pack\n" });
	});

	test("a damaged pack fails loudly instead of reading as no prompts", () => {
		const native = join(root, "damaged");
		mkdirSync(native);
		writeFileSync(join(native, PROMPT_PACK), "{");
		expect(() => readPromptSources(native)).toThrow(SyntaxError);
	});
});
