import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANSI16_RGB, rgbToAnsi16 } from "../src/ansi16.ts";
import { colorToRgb, indexedColor } from "../src/colors.ts";

describe("16-color mapping", () => {
	it("keeps a chromatic color chromatic: status colors keep their hue instead of turning gray", () => {
		assert.equal(rgbToAnsi16({ r: 255, g: 107, b: 107 }), 9, "octocode-dark error, a pastel red");
		assert.equal(rgbToAnsi16({ r: 255, g: 95, b: 95 }), 9, "indexed 203, octocode-ansi error");
		assert.equal(rgbToAnsi16({ r: 192, g: 132, b: 252 }), 13, "octocode-dark accent, a pastel violet");
		assert.equal(rgbToAnsi16({ r: 22, g: 101, b: 52 }), 2, "octocode-light success, a dark green");
		assert.equal(rgbToAnsi16({ r: 133, g: 92, b: 0 }), 3, "an amber warning stays yellow, apart from the error red");
	});

	it("maps grays by lightness and each palette color to itself", () => {
		assert.equal(rgbToAnsi16({ r: 139, g: 148, b: 158 }), 8);
		assert.equal(rgbToAnsi16({ r: 10, g: 10, b: 10 }), 0);
		assert.equal(rgbToAnsi16({ r: 250, g: 250, b: 250 }), 15);
		ANSI16_RGB.forEach((rgb, index) => assert.equal(rgbToAnsi16(rgb), index));
	});

	it("reads indexed colors 0-15 from the same palette the 16-color tier targets", () => {
		for (let index = 0; index < 16; index++) assert.deepEqual(colorToRgb(indexedColor(index)), ANSI16_RGB[index]);
	});
});
