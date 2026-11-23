import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { AUTO_SCROLL_MAX_LINES, SelectionAutoScroll } from "../src/tui-alt-screen/selection-auto-scroll.ts";

/** A transcript of `height` rows shown in rows 0..9 of the screen, scrolled to `top`. */
function fixture(height: number, top: number) {
	const scrollView = new ScrollView({ render: () => [], invalidate() {} });
	scrollView.updateLayout(height, 10, () => {});
	scrollView.scrollTo(top);
	const extended: number[] = [];
	const autoScroll = new SelectionAutoScroll({
		visibleRows: () => ({ scrollView, visibleTop: 0, visibleBottom: 9 }),
		extendTo: (_view, _x, y) => extended.push(y),
		requestRender() {},
	});
	return { scrollView, autoScroll, extended };
}

describe("selection auto-scroll", () => {
	it("does not scroll while the pointer is inside the view", () => {
		const { autoScroll } = fixture(1000, 500);
		autoScroll.update({ x: 3, y: 5 });
		assert.equal(autoScroll.active, false);
	});

	it("scrolls further per tick the further the pointer is past the edge", () => {
		const { scrollView, autoScroll } = fixture(1000, 500);
		autoScroll.update({ x: 3, y: 9 });
		autoScroll.tick();
		assert.equal(scrollView.scrollTop, 501, "on the last row: one line");
		autoScroll.update({ x: 3, y: 14 });
		autoScroll.tick();
		assert.equal(scrollView.scrollTop, 507, "five rows below the view: six lines");
		autoScroll.stop();
	});

	it("speeds up while held at the top row, which the pointer cannot pass", () => {
		const { scrollView, autoScroll, extended } = fixture(5000, 4990);
		autoScroll.update({ x: 3, y: 0 });
		for (let tick = 0; tick < 200; tick++) autoScroll.tick();
		// 200 ticks (10 s at 20 Hz) at one line each would cover 200 rows; the ramp crosses far more.
		assert.ok(4990 - scrollView.scrollTop > 2000, `moved ${4990 - scrollView.scrollTop} rows`);
		assert.equal(autoScroll.step, 21, "one line more every half second");
		for (let tick = 0; tick < 50; tick++) autoScroll.tick();
		assert.equal(autoScroll.step, AUTO_SCROLL_MAX_LINES);
		assert.ok(extended.length > 0 && extended.every((y) => y === 0));
		autoScroll.stop();
	});

	it("stops at the end of the content and when the direction reverses it starts slow again", () => {
		const { scrollView, autoScroll } = fixture(30, 18);
		autoScroll.update({ x: 0, y: 9 });
		for (let tick = 0; tick < 5; tick++) autoScroll.tick();
		assert.equal(scrollView.scrollTop, 20);
		assert.equal(autoScroll.active, false, "nothing left to scroll");
		autoScroll.update({ x: 0, y: 0 });
		assert.equal(autoScroll.step, 1);
		autoScroll.stop();
	});
});
