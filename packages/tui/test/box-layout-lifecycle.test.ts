import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import type { Component, TuiMouseEvent } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { visibleWidth } from "../src/utils/width.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const click: TuiMouseEvent = {
	type: "click",
	button: "left",
	x: 0,
	y: 0,
	screenX: 0,
	screenY: 0,
	width: 80,
	height: 1,
	shift: false,
	alt: false,
	ctrl: false,
	clickCount: 1,
};

describe("Box painted action lifecycle", () => {
	for (const mutation of ["clear", "remove", "replace"] as const) {
		it(`does not activate a detached action after ${mutation}`, () => {
			const box = new Box(0, 0);
			let clicks = 0;
			const child: Component = {
				invalidate() {},
				render: () => ["Old action"],
				handleMouse: () => {
					clicks++;
					return { handled: true };
				},
			};
			box.addChild(child);
			box.render(80);
			if (mutation === "clear") box.clear();
			else if (mutation === "remove") box.removeChild(child);
			else box.children = [new Text("New action", 0, 0)];
			assert.equal(box.handleMouse(click), undefined);
			assert.equal(clicks, 0);
			box.render(80);
			assert.equal(box.handleMouse(click), undefined);
			assert.equal(clicks, 0);
		});
	}

	for (const axis of ["x", "y"] as const) {
		it(`keeps the painted ${axis} padding until redraw`, () => {
			const box = new Box(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0);
			let received: TuiMouseEvent | undefined;
			box.addChild({
				invalidate() {},
				render: () => ["Action"],
				handleMouse: (event) => {
					received = event;
					return { handled: true };
				},
			});
			box.render(80);
			if (axis === "x") box.setPaddingX(0);
			else box.setPaddingY(0);
			box.handleMouse({ ...click, [axis]: 1, height: 3 });
			assert.equal(received?.[axis], 0);
			box.render(80);
			box.handleMouse(click);
			assert.equal(received?.[axis], 0);
		});
	}

	it("keeps an empty painted frame inactive until a replacement is painted", () => {
		const box = new Box(0, 0);
		box.addChild(new Text("Old action", 0, 0));
		box.render(80);
		box.clear();
		box.render(80);
		let clicks = 0;
		box.addChild({
			invalidate() {},
			render: () => ["New action"],
			handleMouse: () => {
				clicks++;
				return { handled: true };
			},
		});
		box.handleMouse(click);
		assert.equal(clicks, 0);
		box.render(80);
		box.handleMouse(click);
		assert.equal(clicks, 1);
	});
});

describe("narrow component composition", () => {
	for (const width of [1, 2, 3, 4, 5, 8]) {
		it(`keeps padded Box and Markdown content within ${width} columns`, () => {
			const box = new Box(2, 0);
			box.addChild(new Markdown("abcdef", 2, 0, defaultMarkdownTheme));
			const lines = box.render(width);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= width),
				JSON.stringify(lines),
			);
			assert.equal(lines.map((line) => stripTerminalSequences(line).trim()).join(""), "abcdef");
		});

		it(`uses the painted padding for mouse coordinates at ${width} columns`, () => {
			const box = new Box(2, 0);
			let renderedWidth = 0;
			let received: TuiMouseEvent | undefined;
			box.addChild({
				invalidate() {},
				render: (contentWidth) => {
					renderedWidth = contentWidth;
					return ["x"];
				},
				handleMouse: (event) => {
					received = event;
					return { handled: true };
				},
			});
			const [line] = box.render(width);
			const x = line.indexOf("x");
			box.handleMouse({ ...click, width, x });
			assert.ok(received);
			assert.equal(received.x, 0);
			assert.equal(received.width, renderedWidth);
			assert.ok(renderedWidth <= width);
		});
	}
});
