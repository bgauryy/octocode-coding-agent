import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";

const native = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-native-"));
const dir = path.join(native, "prompts");
fs.mkdirSync(path.join(dir, "subagent"), { recursive: true });
fs.mkdirSync(path.join(dir, "rendered"));
// Tool text keeps its folder in the key; skills are not prompt text.
fs.mkdirSync(path.join(native, "tools", "bash"), { recursive: true });
fs.writeFileSync(path.join(native, "tools", "bash", "cli.md"), "CLI\n");
fs.mkdirSync(path.join(native, "skills", "demo"), { recursive: true });
fs.writeFileSync(path.join(native, "skills", "demo", "SKILL.md"), "skill\n");
fs.writeFileSync(path.join(dir, "subagent", "a.md"), "A {{x}}\n");
fs.writeFileSync(path.join(dir, "subagent", "b.md"), "B {{x}}\n");
// Reader-only Markdown of a source checkout: generated final prompts and READMEs are never prompt templates.
fs.mkdirSync(path.join(dir, "final"));
fs.writeFileSync(path.join(dir, "final", "main.md"), "generated\n");
fs.writeFileSync(path.join(dir, "README.md"), "map\n");
fs.writeFileSync(path.join(dir, "subagent", "README.md"), "map\n");

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getNativeDir: () => native,
}));

afterAll(() => fs.rmSync(native, { recursive: true, force: true }));

/**
 * A running process renders the prompt text it started with: the files are read together on first use, so an
 * edit or upgrade on disk while it runs cannot pair its loaded code with a template that names values that code does
 * not pass (a session then failed every subagent start with `unknown name "why"`).
 */
it("reads every prompt file on first use and keeps that text while the files change on disk", async () => {
	const { renderPrompt } = await import("../../src/core/prompt-template.ts");
	expect(renderPrompt("subagent/a.md", { x: 1 })).toBe("A 1");
	fs.writeFileSync(path.join(dir, "subagent", "b.md"), "B {{x}} {{y}}\n");
	fs.writeFileSync(path.join(dir, "subagent", "c.md"), "C\n");
	// b.md was never rendered before the edit, and still renders as it was when the process first read the folder.
	expect(renderPrompt("subagent/b.md", { x: 2 })).toBe("B 2");
	expect(() => renderPrompt("subagent/c.md")).toThrow(/subagent\/c\.md/);
});

it("does not load the generated final prompts or the READMEs of a source checkout", async () => {
	const { promptSource } = await import("../../src/core/prompt-template.ts");
	expect(promptSource("subagent/a.md")).toBe("A {{x}}\n");
	for (const name of ["final/main.md", "README.md", "subagent/README.md", "skills/demo/SKILL.md", "demo/SKILL.md"])
		expect(() => promptSource(name)).toThrow(/no file/);
	expect(promptSource("tools/bash/cli.md")).toBe("CLI\n");
});
