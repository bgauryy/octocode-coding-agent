import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { getExportTemplateDir } from "../src/config.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/theme/theme.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// String.replace() treats `$$`, `$&` and `$'` in the replacement as patterns; the inlined scripts must arrive verbatim,
// so the cost line keeps its literal dollar sign (`$${totalCost...}` in template.js).
it("inlines the template script and the vendored libraries byte for byte", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "export-html-insertion-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "user", content: "hello", timestamp: 0 });
	const output = await exportFromFile(manager.getSessionFile()!, join(dir, "out.html"));
	const html = readFileSync(output, "utf8");
	const templateDir = getExportTemplateDir();
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf8");
	expect(templateJs).toContain("$${totalCost.toFixed(3)}");
	expect(html).toContain(templateJs);
	for (const vendor of ["marked.min.js", "highlight.min.js"])
		expect(html).toContain(readFileSync(join(templateDir, "vendor", vendor), "utf8"));
});
