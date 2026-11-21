import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateDiffString } from "../../src/core/tools/edit-diff.ts";
import { renderFileResult } from "../../src/octocode/files/render.ts";
import * as diffModule from "../../src/theme/diff.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripRowMarks } from "@octocodeai/octocode-tui";

const plain = (text: string) => stripRowMarks(text).replace(/\x1b\[[0-9;]*m/g, "");
const before = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join("\n");
const after = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i * 2}; // doubled`).join("\n");
const { diff } = generateDiffString(before, after);
const result = (count: number) => ({
	content: [{ type: "text", text: "ok" }],
	details: {
		outcomes: Array.from({ length: count }, (_, i) => ({ ok: true, type: "edit", path: `src/f${i}.ts`, diff })),
	},
});
const rows = (count: number, expanded: boolean) =>
	renderFileResult(result(count), { expanded }, theme, { isPartial: false, isError: false, expanded, state: {} })
		.render(120)
		.map(plain);

describe("file result preview", () => {
	beforeAll(() => initTheme("dark"));

	it("closes a finished diff to its outcome row, and shows the whole diff expanded", () => {
		const total = diff.split("\n").length;
		expect(total).toBeGreaterThan(400);
		const collapsed = rows(1, false);
		const expanded = rows(1, true);
		expect(collapsed).toEqual([`${expanded[0]} (ctrl+o to expand)`]);
		expect(expanded.length).toBeGreaterThanOrEqual(total);
	});

	it("colours only the start of a long diff while collapsed, and none of it for several changes", () => {
		const render = vi.spyOn(diffModule, "renderDiff");
		rows(1, false);
		expect(render).toHaveBeenCalledTimes(1);
		expect(render.mock.calls[0][0].split("\n").length).toBeLessThan(diff.split("\n").length / 2);
		render.mockClear();
		const several = rows(3, false);
		expect(render).not.toHaveBeenCalled();
		expect(several.join("\n")).toContain(`+${3 * diff.split("\n").length} diff lines`);
		render.mockRestore();
	});
});
