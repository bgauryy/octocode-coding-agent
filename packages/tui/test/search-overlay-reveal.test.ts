import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { Container } from "../src/tui/container.ts";
import { AltScreenSearchController } from "../src/tui-alt-screen/search-controller.ts";

const OVERLAY = { row: 1, col: 30, width: 40, height: 3 };

function fixture() {
	const document = new Container();
	for (let index = 0; index < 100; index++)
		document.addChild(new Text(index === 51 ? "the needle" : `row ${index}`, 0, 0));
	const scroll = new ScrollView(document, { primary: true });
	const search = new AltScreenSearchController(
		{
			implicitScrollView: scroll,
			getPrimaryScrollView: () => scroll,
			requestRender() {},
			showOverlay: () => ({
				hide() {},
				setHidden() {},
				isHidden: () => false,
				focus() {},
				unfocus() {},
				isFocused: () => false,
				getBounds: () => OVERLAY,
			}),
		},
		{ navigationButton: (text) => text },
	);
	return { scroll, search };
}

test("a selected match drawn under the search overlay is scrolled below it", () => {
	const { scroll, search } = fixture();
	try {
		renderLayoutFrame(scroll, 70, 20, () => {});
		scroll.scrollTo(50, { disableFollow: true });
		let layout = renderLayoutFrame(scroll, 70, 20, () => {});
		search.toggleSearch();
		search.activeSearch!.component.handleInput("needle");
		search.refreshSearch(layout);
		layout = renderLayoutFrame(scroll, 70, 20, () => {});
		search.refreshSearch(layout);
		const match = search.activeSearch!.matches[0];
		assert.ok(match, "the needle is found");
		const viewportRow = match.segments[0].row - scroll.scrollTop;
		assert.ok(
			viewportRow >= OVERLAY.row + OVERLAY.height,
			`the match is on viewport row ${viewportRow}, under the overlay (rows ${OVERLAY.row}-${OVERLAY.row + OVERLAY.height - 1})`,
		);
	} finally {
		scroll.detach();
	}
});
