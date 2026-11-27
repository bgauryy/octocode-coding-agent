import type { TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/theme/theme.ts";

function row() {
	const keepScrollbackOnCollapse = vi.fn();
	const ui = { requestRender: () => {}, keepScrollbackOnCollapse } as unknown as TUI;
	const component = new ToolExecutionComponent("plain_tool", "id-1", {}, {}, undefined, ui, process.cwd());
	component.updateResult({ content: [{ type: "text", text: "output" }], isError: false });
	return { component, keepScrollbackOnCollapse };
}

describe("ToolExecutionComponent collapse", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("tells the screen when an expanded result collapses", () => {
		const { component, keepScrollbackOnCollapse } = row();
		component.setExpanded(true);
		expect(keepScrollbackOnCollapse).not.toHaveBeenCalled();
		component.setExpanded(false);
		expect(keepScrollbackOnCollapse).toHaveBeenCalledTimes(1);
	});

	test("a row that was never expanded does not announce a collapse (transcript rebuilds set it collapsed)", () => {
		const { component, keepScrollbackOnCollapse } = row();
		component.setExpanded(false);
		expect(keepScrollbackOnCollapse).not.toHaveBeenCalled();
	});

	test("works on a screen without the hook", () => {
		const component = new ToolExecutionComponent(
			"plain_tool",
			"id-2",
			{},
			{},
			undefined,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		expect(() => component.setExpanded(false)).not.toThrow();
	});
});
