import type { TUI } from "@octocodeai/octocode-tui";
import { beforeAll, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/theme/theme.ts";

beforeAll(() => initTheme("dark"));

it("redraws a tool row only when its arguments changed", () => {
	const renderCall = vi.fn((args: { path: string }) => ({ render: () => [args.path], invalidate() {} }));
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const row = new ToolExecutionComponent(
		"read",
		"c1",
		{ path: "a.ts" },
		{},
		{ renderCall } as never,
		ui,
		process.cwd(),
	);
	const drawn = renderCall.mock.calls.length;

	// A streamed reply repeats every call's arguments, as equal copies, on each delta.
	row.updateArgs({ path: "a.ts" });
	row.updateArgs(structuredClone({ path: "a.ts" }));
	expect(renderCall).toHaveBeenCalledTimes(drawn);

	row.updateArgs({ path: "b.ts" });
	expect(renderCall).toHaveBeenCalledTimes(drawn + 1);
	expect(row.render(80).join("\n")).toContain("b.ts");
});
