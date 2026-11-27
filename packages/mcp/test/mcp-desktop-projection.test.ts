import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "../src/client/index.ts";
import { projectDesktopResult, projectStructured } from "../src/presets/desktop/projection.ts";
import { withStructuredText } from "../src/presets/structured-text.ts";

/** Real Cua Driver 0.30.4 results (Calculator only; screenshots replaced by a 1x1 PNG, list_apps hand-trimmed to fake apps). */
function fixture(name: string): CallToolResult {
	return JSON.parse(readFileSync(new URL(`./fixtures/desktop/${name}.json`, import.meta.url), "utf8"));
}

const textOf = (result: CallToolResult) =>
	(result.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

describe("desktop result projection", () => {
	const full = fixture("get_window_state.calculator");
	const structured = full.structuredContent as Record<string, unknown>;

	it("shrinks a 141-element window read to under 25% of the full append and keeps the driver text whole", () => {
		const before = textOf(withStructuredText(full)).length;
		const projected = projectDesktopResult("get_window_state", full);
		const after = textOf(projected).length;
		expect(before).toBeGreaterThan(55_000); // 13,377 text + the whole JSON, as recorded
		expect(after).toBeLessThan(before * 0.25);
		expect(textOf(projected).startsWith(textOf(full))).toBe(true);
		expect(textOf(projected)).toContain("[5] AXButton (7) [id=Seven actions=[press]]");
	});

	it("keeps the snapshot id, window ids, counts and the markers a click or a retry needs", () => {
		const kept = projectStructured("get_window_state", structured) as Record<string, unknown>;
		expect(kept).toMatchObject({
			snapshot_id: structured.snapshot_id,
			capture_id: structured.capture_id,
			window_id: 9663,
			pid: 60161,
			window_title: "Calculator",
			app_name: "Calculator",
			window_bounds: { height: 408, width: 230, x: 894, y: 445 },
			element_count: 141,
			returned_element_count: 141,
			total_element_count: 141,
			elements_complete: false,
			truncated: false,
			nodes_pending: 0,
			screenshot_width: 460,
			screenshot_height: 816,
			screenshot_scale: 2,
			screenshot_frame_valid: true,
			element_token_format: "<snapshot_id>:<element_index>",
		});
		expect(kept.background_input).toEqual(structured.background_input);
		// The token a click takes is the snapshot id and the index the text lists for the element.
		const seven = (structured.elements as Array<Record<string, unknown>>).find((element) => element.label === "7");
		expect(seven?.element_token).toBe(`${structured.snapshot_id}:${seven?.element_index}`);
		expect(kept.element_tokens).toBeUndefined();
	});

	it("drops what the text already lists", () => {
		const kept = projectStructured("get_window_state", structured) as Record<string, unknown>;
		for (const key of ["elements", "tree_markdown", "_note"]) expect(kept, key).not.toHaveProperty(key);
	});

	it("keeps the partial-tree markers of a bounded read", () => {
		const bounded = fixture("get_window_state.calculator-bounded");
		const kept = projectStructured("get_window_state", bounded.structuredContent) as Record<string, unknown>;
		expect(kept).toMatchObject({
			truncated: true,
			truncation_reason: "node_budget",
			nodes_pending: 26,
			nodes_visited: 40,
		});
		expect(textOf(projectDesktopResult("get_window_state", bounded))).toContain("PARTIAL TREE");
	});

	it("keeps a token that is not snapshot:index, and the elements it cannot rely on the text for", () => {
		const odd = projectStructured("get_window_state", {
			snapshot_id: "s1",
			tree_markdown: "- [0] AXWindow",
			elements: [
				{ element_index: 0, element_token: "s1:0", enabled: true },
				{ element_index: 1, element_token: "other:9", enabled: false },
			],
		}) as Record<string, unknown>;
		expect(odd.element_tokens).toEqual({ "1": "other:9" });
		expect(odd.disabled_elements).toEqual([1]);
		const noTree = { snapshot_id: "s1", elements: [{ element_index: 0, element_token: "s1:0" }] };
		expect(projectStructured("get_window_state", noTree)).toEqual(noTree);
	});

	it("keeps every window of list_windows (the text is only a count) without null space fields", () => {
		const windows = fixture("list_windows.calculator");
		const kept = projectStructured("list_windows", windows.structuredContent) as {
			current_space_id: number;
			windows: Array<Record<string, unknown>>;
		};
		expect(textOf(windows)).toBe("Found 5 window(s).");
		expect(kept.current_space_id).toBe(1);
		expect(kept.windows.map((window) => window.window_id)).toEqual([9665, 9663, 9667, 9666, 9664]);
		expect(kept.windows[1]).toEqual({
			app_name: "Calculator",
			bounds: { height: 408, width: 230, x: 894, y: 445 },
			current_space_id: 1,
			is_on_screen: true,
			on_current_space: true,
			pid: 60161,
			space_ids: [1],
			title: "Calculator",
			window_id: 9663,
			z_index: 125,
		});
		expect(kept.windows[0]).not.toHaveProperty("space_ids");
		expect(kept.windows[0]).not.toHaveProperty("layer");
		expect(JSON.stringify(kept).length).toBeLessThan(JSON.stringify(windows.structuredContent).length);
	});

	it("keeps only the on-screen windows of a whole-desktop listing and says how to list one app", () => {
		// Invented apps and titles: a real listing names every window the user has open.
		const windows = Array.from({ length: 60 }, (_, index) => ({
			app_name: `App${index % 9}`,
			pid: 1000 + (index % 9),
			window_id: 5000 + index,
			title: index % 6 === 0 ? `Window ${index}` : "",
			is_on_screen: index % 6 === 0,
			layer: 0,
			bounds: { x: 0, y: 0, width: 100 + index, height: 80 },
			space_ids: null,
		}));
		const projected = projectStructured("list_windows", { current_space_id: 1, windows }) as {
			windows: Array<{ window_id: number; is_on_screen: boolean }>;
			windows_omitted: number;
			note: string;
		};
		expect(projected.windows).toHaveLength(10);
		expect(projected.windows.every((window) => window.is_on_screen)).toBe(true);
		expect(projected.windows_omitted).toBe(50);
		expect(projected.note).toMatch(/pass `pid`/);
		expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify({ windows }).length / 3);
		// One app's listing (a dozen windows or fewer) keeps every window, hidden ones included.
		const one = projectStructured("list_windows", { windows: windows.slice(0, 5) }) as { windows: unknown[] };
		expect(one.windows).toHaveLength(5);
	});

	it("keeps every app of list_apps by name, bundle id, pid and running state", () => {
		const apps = fixture("list_apps.fake");
		const kept = projectStructured("list_apps", apps.structuredContent) as { apps: unknown[] };
		expect(kept.apps).toEqual([
			{ bundle_id: "com.example.alpha", name: "Alpha Notes", pid: 101, running: true },
			{ bundle_id: "com.example.beta", name: "Beta Mail", pid: 102, running: true },
			{ bundle_id: "com.example.gamma", name: "Gamma Paint", running: false },
			{ bundle_id: "com.example.delta", name: "Delta Sheets", running: false },
		]);
	});

	it("leaves a tool it was not studied for exactly as today, whole", () => {
		for (const name of ["verify_state.calculator", "get_desktop_state"]) {
			const result = fixture(name);
			const tool = name.split(".")[0];
			expect(projectStructured(tool, result.structuredContent)).toBe(result.structuredContent);
			expect(projectDesktopResult(tool, result)).toEqual(withStructuredText(result));
		}
		expect(projectStructured("some_new_tool", { elements: [1, 2], tree_markdown: "x" })).toEqual({
			elements: [1, 2],
			tree_markdown: "x",
		});
		expect(projectStructured("constructor", { a: 1 })).toEqual({ a: 1 });
	});

	it("keeps an error result's full envelope", () => {
		const error: CallToolResult = {
			isError: true,
			content: [{ type: "text", text: "pid 1 owns more than one window" }],
			structuredContent: { elements: [1], tree_markdown: "x", candidates: [{ window_id: 2 }] },
		};
		expect(projectDesktopResult("get_window_state", error)).toEqual(withStructuredText(error));
	});
});
