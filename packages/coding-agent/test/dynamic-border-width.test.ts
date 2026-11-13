import { describe, expect, it, vi } from "vitest";
import { DynamicBorder } from "../src/theme/dynamic-border.ts";

describe("DynamicBorder viewport bounds", () => {
	it("omits the border when no columns are available and recovers after resize", () => {
		const color = vi.fn((text: string) => text);
		const border = new DynamicBorder(color);
		expect(border.render(0)).toEqual([]);
		expect(color).not.toHaveBeenCalled();
		expect(border.render(4)).toEqual(["────"]);
		expect(border.render(0)).toEqual([]);
		expect(border.render(2)).toEqual(["──"]);
	});
});
