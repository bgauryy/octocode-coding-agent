import assert from "node:assert/strict";
import { it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { getScrollbarGeometry } from "../src/layout/scrollbar.ts";
import { AltScreenScrollbar } from "../src/tui-alt-screen/scrollbar-controller.ts";

it("track clicks page repeatedly while thumb presses preserve the drag offset", () => {
	const scroll = new ScrollView(new Text("line\n".repeat(100), 0, 0), { scrollbar: "always" });
	let frame = renderLayoutFrame(scroll, 40, 10, () => {});
	let resets = 0;
	const controller = new AltScreenScrollbar({
		getCurrentLayout: () => frame,
		hasOverlay: () => false,
		resetTextSelection: () => {
			resets++;
		},
	});
	const geometry = () => getScrollbarGeometry(getScrollViewBox(frame, scroll)!)!;
	const drag = () => controller.scrollbarDrag;
	const press = (y: number) =>
		controller.handleScrollbarMouseEvent({ button: 0, x: geometry().column, y, release: false });
	const release = (y: number) =>
		controller.handleScrollbarMouseEvent({ button: 0, x: geometry().column, y, release: true });
	assert.equal(press(9), true);
	assert.equal(scroll.scrollTop, 10);
	assert.equal(drag(), undefined);
	release(9);
	frame = renderLayoutFrame(scroll, 40, 10, () => {});
	press(9);
	assert.equal(scroll.scrollTop, 20);
	release(9);
	frame = renderLayoutFrame(scroll, 40, 10, () => {});
	press(0);
	assert.equal(scroll.scrollTop, 10);
	release(0);
	frame = renderLayoutFrame(scroll, 40, 10, () => {});
	const thumb = geometry();
	press(thumb.thumbTop);
	assert.equal(scroll.scrollTop, 10, "grabbing the thumb must not jump");
	assert.equal(drag()?.grabOffset, 0);
	controller.handleScrollbarMouseEvent({ button: 32, x: thumb.column, y: 9, release: false });
	assert.equal(scroll.scrollTop, thumb.maxScrollTop);
	release(9);
	assert.equal(drag(), undefined);
	assert.equal(resets, 4);
	scroll.detach();
});

it("auto thumb hides after inactivity both off the end and following end", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const content = new Text("line\n".repeat(100), 0, 0);
	const scroll = new ScrollView(content, { scrollbar: "auto", follow: "end", scrollbarHideDelayMs: 20 });
	const render = () => renderLayoutFrame(scroll, 40, 10, () => {});
	render();
	scroll.scrollBy(-10);
	assert.equal(scroll.isScrollbarVisible, true);
	t.mock.timers.tick(21);
	assert.equal(scroll.isScrollbarVisible, false);
	content.setText("line\n".repeat(120));
	render();
	t.mock.timers.tick(40);
	assert.equal(scroll.isFollowingEnd, false);
	assert.equal(scroll.isScrollbarVisible, false);
	scroll.scrollToEnd();
	assert.equal(scroll.isScrollbarVisible, true);
	t.mock.timers.tick(21);
	assert.equal(scroll.isFollowingEnd, true);
	assert.equal(scroll.isScrollbarVisible, false);
	scroll.detach();
});
