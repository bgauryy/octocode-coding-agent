import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { writtenSummary } from "./octocode/fixtures/compaction-summary.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function exported() {
	const dir = mkdtempSync(join(tmpdir(), "export-compaction-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 });
	const kept = manager.appendMessage({ role: "user", content: [{ type: "text", text: "kept" }], timestamp: 2 });
	manager.appendCompaction(writtenSummary(), kept, 9000);
	return exportFromFile(manager.getSessionFile()!, join(dir, "out.html")).then((path) => readFileSync(path, "utf8"));
}

it("exports the compaction summary as a person reads it and renders it as Markdown", async () => {
	const html = await exported();
	const data = /<script id="session-data"[^>]*>([^<]+)<\/script>/.exec(html)?.[1];
	expect(data).toBeDefined();
	const session = JSON.parse(Buffer.from(data!, "base64").toString("utf8"));
	const entry = session.entries.find((item: { type: string }) => item.type === "compaction");
	expect(entry.summaryDisplay).toContain("**Compacted 9,000 tokens");
	expect(entry.summaryDisplay).toContain("## Goal\nFix the login bug");
	expect(entry.summaryDisplay).not.toContain("<user-message>");
	expect(entry.summaryDisplay).not.toContain("## Recovery");
	expect(html).toContain("safeMarkedParse(entry.summaryDisplay ?? entry.summary)");
});
