import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import {
	AUTO_SCROLL_INTERVAL_MS,
	AUTO_SCROLL_MAX_LINES,
	SelectionAutoScroll,
} from "../src/tui-alt-screen/selection-auto-scroll.ts";

/** Ticks in `ms` of a held drag. */
const ticksIn = (ms: number) => ms / AUTO_SCROLL_INTERVAL_MS;

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

	it("moves on the first tick and scrolls faster the further the pointer is past the edge", () => {
		const near = fixture(1000, 500);
		near.autoScroll.update({ x: 3, y: 9 });
		near.autoScroll.tick();
		assert.equal(near.scrollView.scrollTop, 501, "on the last row: one line at once");
		for (let tick = 1; tick < ticksIn(400); tick++) near.autoScroll.tick();
		assert.equal(near.scrollView.scrollTop - 500, 9, "one line per 50 ms, plus the first");
		near.autoScroll.stop();

		const far = fixture(1000, 500);
		far.autoScroll.update({ x: 3, y: 14 });
		for (let tick = 0; tick < ticksIn(400); tick++) far.autoScroll.tick();
		assert.equal(far.scrollView.scrollTop - 500, 49, "five rows below the view: six lines per 50 ms");
		far.autoScroll.stop();
	});

	it("moves in even whole-line steps that never exceed the speed's share of a tick", () => {
		const { scrollView, autoScroll } = fixture(100_000, 50_000);
		autoScroll.update({ x: 3, y: 30 });
		const steps: number[] = [];
		for (let tick = 0; tick < ticksIn(2000); tick++) {
			const top = scrollView.scrollTop;
			autoScroll.tick();
			steps.push(scrollView.scrollTop - top);
		}
		// 22 rows past the edge: 22 lines per 50 ms is 17.6 per tick, so each tick moves 17 or 18 lines (19 at the ramp).
		assert.ok(Math.min(...steps.slice(1)) >= 17, `steps ${steps.join(",")}`);
		assert.ok(Math.max(...steps) <= Math.ceil((AUTO_SCROLL_MAX_LINES * AUTO_SCROLL_INTERVAL_MS) / 50) + 1);
		autoScroll.stop();
	});

	it("speeds up while held at the top row, which the pointer cannot pass", () => {
		const { scrollView, autoScroll, extended } = fixture(5000, 4990);
		autoScroll.update({ x: 3, y: 0 });
		for (let tick = 0; tick < ticksIn(10_000); tick++) autoScroll.tick();
		// 10 s at one line per 50 ms would cover 200 rows; the ramp crosses far more.
		assert.ok(4990 - scrollView.scrollTop > 2000, `moved ${4990 - scrollView.scrollTop} rows`);
		assert.equal(autoScroll.step, 21, "one line more every half second");
		for (let tick = 0; tick < ticksIn(2000); tick++) autoScroll.tick();
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
