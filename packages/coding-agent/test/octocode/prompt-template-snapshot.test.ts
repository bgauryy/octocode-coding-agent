import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-instructions-"));
fs.mkdirSync(path.join(dir, "subagent"));
fs.mkdirSync(path.join(dir, "rendered"));
fs.writeFileSync(path.join(dir, "subagent", "a.md"), "A {{x}}\n");
fs.writeFileSync(path.join(dir, "subagent", "b.md"), "B {{x}}\n");

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getInstructionsDir: () => dir,
}));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * A running process renders the instruction text it started with: the files are read together on first use, so an
 * edit or upgrade on disk while it runs cannot pair its loaded code with a template that names values that code does
 * not pass (a session then failed every subagent start with `unknown name "why"`).
 */
it("reads every instruction file on first use and keeps that text while the files change on disk", async () => {
	const { renderInstruction } = await import("../../src/core/prompt-template.ts");
	expect(renderInstruction("subagent/a.md", { x: 1 })).toBe("A 1");
	fs.writeFileSync(path.join(dir, "subagent", "b.md"), "B {{x}} {{y}}\n");
	fs.writeFileSync(path.join(dir, "subagent", "c.md"), "C\n");
	// b.md was never rendered before the edit, and still renders as it was when the process first read the folder.
	expect(renderInstruction("subagent/b.md", { x: 2 })).toBe("B 2");
	expect(() => renderInstruction("subagent/c.md")).toThrow(/subagent\/c\.md/);
});
