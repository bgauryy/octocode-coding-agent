import type { TuiMouseEvent } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/**
 * The team panel is a widget below the editor that opens an agent's detail on a left click on its row. This drives the
 * same mount through the fullscreen host: a click on the screen reaches the widget with the row it hit, counted from the
 * widget's first row.
 */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

describe("a click on a widget below the editor", () => {
	it("reaches the widget with its own row, and repaints what the widget changed", async () => {
		t = await startUi();
		const clicks: TuiMouseEvent[] = [];
		const open = new Set<number>();
		t.host.setFeatureWidget(
			"probe",
			() => ({
				render: () => [0, 1, 2].map((row) => `probe-agent-${row}${open.has(row) ? " detail open" : ""}`),
				handleMouse: (event: TuiMouseEvent) => {
					if (event.type !== "click" || event.button !== "left") return undefined;
					clicks.push(event);
					if (!open.delete(event.y)) open.add(event.y);
					t!.host.ui.requestRender();
					return { handled: true };
				},
				invalidate: () => undefined,
			}),
			{ placement: "belowEditor" },
		);
		await t.until(async () => (await t!.text()).includes("probe-agent-2"), "widget on screen");

		const grid = await t.grid();
		const row = grid.findIndex((line) => line.includes("probe-agent-1"));
		const col = grid[row].indexOf("probe-agent-1") + 3;
		t.press(`\x1b[<0;${col};${row + 1}M`);
		t.press(`\x1b[<0;${col};${row + 1}m`);
		await t.until(() => clicks.length > 0, "the click reaches the widget");
		expect(clicks).toHaveLength(1);
		expect(clicks[0]).toMatchObject({ type: "click", button: "left", y: 1 });
		await t.until(async () => (await t!.text()).includes("probe-agent-1 detail open"), "the open row repainted");
	});
});
