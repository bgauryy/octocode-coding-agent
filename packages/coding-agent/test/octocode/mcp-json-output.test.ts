import { beforeAll, describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../../../mcp/src/tool-definition.ts";
import { installMcpRenderPort } from "../../src/octocode/mcp-host/render.ts";
import { installMcpUiPort } from "../../src/modes/interactive/mcp-ui.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
	installMcpRenderPort();
	installMcpUiPort();
});

const tool = createMcpToolDefinition({
	server: "s",
	tool: { name: "search", description: "Search.", inputSchema: { type: "object" } },
	name: "mcp__s__search",
	exposure: "direct",
	namespace: { name: "mcp__s" },
	timeoutMs: 1000,
	getClient: async () => ({ callTool: async () => ({ content: [] }) }),
});

/** The row's result lines for `text`, collapsed or expanded. */
function rows(text: string, expanded: boolean, isError = false): string[] {
	return tool.renderResult!(
		{ content: [{ type: "text", text }], details: { server: "s", tool: "search" } },
		{ expanded, isPartial: false },
		theme,
		{ isPartial: false, isError, showImages: false, lastComponent: undefined, expanded } as never,
	).render(200);
}

const ANSI = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const plain = (lines: string[]) => lines.map((line) => line.replace(ANSI, "").trimEnd());

const JSON_RESULT =
	'{"results":[{"matchCount":3,"ok":true,"path":"src/a.ts","id":12345678901234567890,"none":null,"empty":[]}]}';

describe("MCP tool rows colour JSON results", () => {
	it("colours keys, strings and numbers apart, as code blocks colour JSON", () => {
		const text = rows(JSON_RESULT, false).join("\n");
		expect(text).toContain(theme.fg("syntaxVariable", '"matchCount"'));
		expect(text).toContain(theme.fg("syntaxString", '"src/a.ts"'));
		expect(text).toContain(theme.fg("syntaxNumber", "3"));
		expect(text).toContain(theme.fg("syntaxNumber", "true"));
	});

	it("keeps the server's compact layout collapsed and indents it expanded, without changing a value", () => {
		expect(plain(rows(JSON_RESULT, false)).filter(Boolean)).toEqual([JSON_RESULT]);
		expect(plain(rows(JSON_RESULT, true)).filter(Boolean)).toEqual([
			"{",
			'  "results": [',
			"    {",
			'      "matchCount": 3,',
			'      "ok": true,',
			'      "path": "src/a.ts",',
			'      "id": 12345678901234567890,',
			'      "none": null,',
			'      "empty": []',
			"    }",
			"  ]",
			"}",
		]);
	});

	it("leaves text that is not one JSON document as plain output", () => {
		for (const text of ["Found 3 files in src", '{"open":', 'Result: {"a":1}', "42"]) {
			const out = rows(text, true).join("\n");
			expect(out).toContain(theme.fg("toolOutput", text));
			expect(out).not.toContain(theme.fg("syntaxVariable", '"a"'));
		}
	});

	it("draws a failed call's JSON in the error colour", () => {
		const out = rows('{"error":"boom"}', true, true).join("\n");
		expect(out).toContain(theme.fg("error", '{"error":"boom"}'));
	});
});
