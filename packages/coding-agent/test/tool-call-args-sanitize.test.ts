/**
 * Tool-call arguments come from the model or an MCP server. Their header (`formatToolCallWithArgs`) must not pass
 * terminal controls through: an OSC 0 title, an OSC 8 link, an 8-bit CSI or a bidi override in an argument.
 */
import type { TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { createMcpToolRenderers } from "../../mcp/src/tool-definition.ts";
import { installMcpRenderPort } from "../src/octocode/mcp-host/render.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

const HOSTILE = {
	"title\u001b]0;key\u0007": "a\u001b]0;pwned\u0007b",
	link: "\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007",
	csi: "x\u009b2Jy",
	bidi: "safe\u202etxt.exe",
	nested: { deep: "\u009d0;nested\u0007" },
};

function expectNoControls(rendered: string, expanded: boolean): void {
	expect(rendered).not.toContain("\u001b]");
	expect(rendered).not.toContain("\u0007");
	expect(rendered).not.toContain("\u009b");
	expect(rendered).not.toContain("\u009d");
	expect(rendered).not.toContain("\u202e");
	// Expanded rows show every value whole; the collapsed preview is cut at 100 characters.
	if (expanded) expect(rendered).toContain("safetxt.exe");
	expect(rendered).toContain("title");
}

const ui = { requestRender: () => {} } as unknown as TUI;

describe("tool-call argument headers strip terminal controls", () => {
	beforeAll(() => {
		initTheme("dark");
		installMcpRenderPort();
	});

	for (const expanded of [false, true]) {
		test(`generic tool row (${expanded ? "expanded" : "collapsed"})`, () => {
			const row = new ToolExecutionComponent("x\u009d0;t\u0007ool", "id", HOSTILE, {}, undefined, ui, process.cwd());
			row.setExpanded(expanded);
			expectNoControls(row.render(400).join("\n"), expanded);
		});

		test(`MCP call row (${expanded ? "expanded" : "collapsed"})`, () => {
			const renderers = createMcpToolRenderers("server/tool");
			const component = renderers.renderCall!(HOSTILE, theme, { expanded });
			expectNoControls(component.render(400).join("\n"), expanded);
		});
	}
});
