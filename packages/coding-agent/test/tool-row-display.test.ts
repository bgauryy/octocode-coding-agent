import { describe, expect, it } from "vitest";
import { rowDisplay } from "../src/modes/interactive/components/tool-execution/display.ts";

describe("terminal tool row display", () => {
	it("reads only a result's text blocks, as RPC, the web view and the export do: an image adds no blank line", () => {
		const display = rowDisplay({
			toolName: "shot",
			args: {},
			result: {
				content: [
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "captured" },
				],
			},
			isPartial: false,
		});
		expect(display.outcome).toEqual({ text: "captured" });
		expect(display.blocks).toEqual([{ type: "text", text: "captured" }]);
	});
});
