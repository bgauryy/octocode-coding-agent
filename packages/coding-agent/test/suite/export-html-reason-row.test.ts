// The native feature set's module installs the host ports where it is composed, its export rows included.
import "../../src/main/native-features.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness } from "./harness.ts";

/**
 * The session layer draws a tool call's reason row in the HTML export through the rows the native feature set
 * installs where it is composed, without importing the terminal components itself.
 */
describe("HTML export of a native tool call", () => {
	it("shows the call's reason row, as the terminal does", async () => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "octocode-export-reason-"));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ sessionManager });
		try {
			sessionManager.appendMessage({ role: "user", content: "list", timestamp: 1 });
			sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "ls", reason: "see what the folder holds" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			});

			const html = readFileSync(await harness.session.exportToHtml(join(dir, "export.html")), "utf8");
			const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
			const session = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
			expect(stripAnsi(session.renderedTools?.["call-1"]?.callHtml ?? "")).toContain("see what the folder holds");
		} finally {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
