// The native feature set installs the export's host rows (the terminal's failure rows among them) where it is composed.
import "../src/main/native-features.ts";
import { Text } from "@octocodeai/octocode-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { readProblems } from "../src/core/diagnostics-log.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { loadExportToolRows } from "../src/core/export-html/tool-rows.ts";
import type { ToolRenderers } from "../src/core/features/types.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

/** The text an export row shows: tags dropped, entities decoded. */
function shown(html: string | undefined): string {
	return (html ?? "")
		.replace(/<[^>]*>/g, "\n")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

const throwing: ToolRenderers = {
	renderCall: () => {
		throw new Error("boom");
	},
	renderResult: () => {
		throw new TypeError("bad result");
	},
};

const result = [{ type: "text", text: "plain output" }];

describe("HTML export of a tool whose renderer throws", () => {
	let dir: string;
	beforeEach(() => {
		initTheme("dark");
		dir = mkdtempSync(join(tmpdir(), "octocode-export-failure-"));
		process.env[ENV_AGENT_DIR] = dir;
	});
	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		rmSync(dir, { recursive: true, force: true });
	});

	async function renderer(renderers: ToolRenderers, options: { hostRows?: boolean } = {}) {
		const rows = await loadExportToolRows();
		return createToolHtmlRenderer({
			getToolRenderers: () => renderers,
			theme,
			cwd: dir,
			reasonRow: rows.reasonRow,
			purposeRows: rows.purposeRows,
			...(options.hostRows === false ? {} : { callFailure: rows.callFailure, resultFailure: rows.resultFailure }),
		});
	}

	it("draws the terminal's failure row for the call and logs the error", async () => {
		const html = (await renderer(throwing)).renderCall("call-1", "weird", { a: 1 });
		const text = shown(html);
		expect(text).toContain("weird");
		expect(text).toContain("Call renderer failed: Error: boom");
		expect(readProblems(join(dir, "problems.json")).map(({ source, message }) => ({ source, message }))).toEqual([
			{ source: "export", message: "weird call renderer failed: boom" },
		]);
	});

	it("draws the failed outcome with the plain output in both views and logs the error once", async () => {
		const rendered = (await renderer(throwing)).renderResult("call-1", "weird", result, undefined, false);
		for (const view of [rendered?.collapsed ?? rendered?.expanded, rendered?.expanded]) {
			expect(shown(view)).toContain("Result renderer failed: TypeError: bad result");
		}
		expect(shown(rendered?.expanded)).toContain("plain output");
		expect(readProblems(join(dir, "problems.json")).map(({ message }) => message)).toEqual([
			"weird result renderer failed: bad result",
		]);
	});

	it("keeps a working renderer's rows unchanged", async () => {
		const working: ToolRenderers = {
			renderCall: () => new Text("call row", 0, 0),
			renderResult: () => new Text("result row", 0, 0),
		};
		const html = await renderer(working);
		expect(shown(html.renderCall("call-1", "fine", {}))).toContain("call row");
		expect(shown(html.renderResult("call-1", "fine", result, undefined, false)?.expanded)).toContain("result row");
		expect(readProblems(join(dir, "problems.json"))).toEqual([]);
	});

	it("lets the error propagate when the host supplies no failure row, after logging it", async () => {
		const html = await renderer(throwing, { hostRows: false });
		expect(() => html.renderCall("call-1", "weird", {})).toThrow("boom");
		expect(() => html.renderResult("call-1", "weird", result, undefined, false)).toThrow("bad result");
		expect(readProblems(join(dir, "problems.json"))).toHaveLength(2);
	});

	it("lets an error outside the tool's renderer propagate", async () => {
		const html = createToolHtmlRenderer({
			getToolRenderers: () => {
				throw new Error("lookup broke");
			},
			theme,
			cwd: dir,
			reasonRow: () => undefined,
			purposeRows: () => undefined,
		});
		expect(() => html.renderCall("call-1", "weird", {})).toThrow("lookup broke");
		expect(readProblems(join(dir, "problems.json"))).toEqual([]);
	});
});
