import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCTOCODE_FAVICON_DATA_URI } from "@octocodeai/octocode-webview";
import { afterEach, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/theme/theme.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("links the Octocode favicon in the exported session page", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "export-html-favicon-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "user", content: "hello", timestamp: 0 });
	const html = readFileSync(await exportFromFile(manager.getSessionFile()!, join(dir, "out.html")), "utf8");
	expect(html).toContain(`<link rel="icon" type="image/png" href="${OCTOCODE_FAVICON_DATA_URI}">`);
	expect(html).not.toContain("{{FAVICON}}");
});
