import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container, type Component, type TuiMouseEvent } from "../src/tui.ts";

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

describe("container mouse lifecycle", () => {
	for (const mutation of ["clear", "remove"] as const) {
		it(`does not activate a detached child after ${mutation} before the next render`, () => {
			const container = new Container();
			let clicks = 0;
			const child: Component = {
				invalidate: () => {},
				render: () => ["Old action"],
				handleMouse: () => {
					clicks++;
					return { handled: true };
				},
			};
			container.addChild(child);
			container.render(80);
			if (mutation === "clear") container.clear();
			else container.removeChild(child);
			container.handleMouse(click);
			assert.equal(clicks, 0);
		});
	}
});

it("does not route an old displayed row to an unpainted replacement", () => {
	const container = new Container();
	let clicks = 0;
	const first: Component = { invalidate() {}, render: () => ["Old action"] };
	const second: Component = {
		invalidate() {},
		render: () => ["New action"],
		handleMouse: () => {
			clicks++;
			return { handled: true };
		},
	};
	container.addChild(first);
	container.addChild(second);
	container.render(80);
	container.removeChild(first);
	container.handleMouse(click);
	assert.equal(clicks, 0);
	container.render(80);
	container.handleMouse(click);
	assert.equal(clicks, 1);
});
