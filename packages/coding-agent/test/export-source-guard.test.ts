import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import { exportSessionToJsonl } from "../src/core/session-export.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/theme/theme.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeAll(() => initTheme("dark"));

/** A persisted session with two branches, so a branch-only export over it would visibly lose data. */
function branchedSession(): { manager: SessionManager; file: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "export-source-guard-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const root = manager.appendMessage(userMsg("first"));
	manager.appendMessage(assistantMsg("branch A"));
	manager.branch(root);
	manager.appendMessage(assistantMsg("branch B"));
	return { manager, file: manager.getSessionFile()!, dir };
}

describe("exports never overwrite the session they read", () => {
	it("refuses a JSONL export to the live session file or a symlink to it, leaving its bytes intact", () => {
		const { manager, file, dir } = branchedSession();
		const before = readFileSync(file, "utf8");
		const alias = join(dir, "alias.jsonl");
		symlinkSync(file, alias);

		expect(() => exportSessionToJsonl(manager, file)).toThrow(/session file/);
		expect(() => exportSessionToJsonl(manager, alias)).toThrow(/session file/);
		expect(readFileSync(file, "utf8")).toBe(before);

		const copy = exportSessionToJsonl(manager, join(dir, "out", "copy.jsonl"));
		expect(readFileSync(copy, "utf8")).toContain("branch B");
	});

	it("refuses an HTML export over the session file it renders", async () => {
		const { manager, file, dir } = branchedSession();
		const before = readFileSync(file, "utf8");
		const alias = join(dir, "alias.jsonl");
		symlinkSync(file, alias);

		await expect(exportSessionToHtml(manager, undefined, file)).rejects.toThrow(/session file/);
		await expect(exportFromFile(file, alias)).rejects.toThrow(/session file/);
		await expect(exportFromFile(alias, file)).rejects.toThrow(/session file/);
		expect(readFileSync(file, "utf8")).toBe(before);

		const html = await exportFromFile(file, join(dir, "out.html"));
		expect(readFileSync(html, "utf8")).toContain("<html");
	});
});
