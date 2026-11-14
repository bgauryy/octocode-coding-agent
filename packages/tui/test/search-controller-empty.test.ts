import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { Container } from "../src/tui/container.ts";
import { AltScreenSearchController } from "../src/tui-alt-screen/search-controller.ts";
import { findAltScreenSearchMatches } from "../src/tui-alt-screen/search-index.ts";

function fixture() {
	const document = new Container();
	let renders = 0;
	for (let index = 0; index < 300; index++) {
		const item = new Text(`entry ${index}: ${"filler ".repeat(30)}`, 0, 0);
		const render = item.render.bind(item);
		item.render = (width) => {
			renders++;
			return render(width);
		};
		document.addChild(item);
	}
	const scroll = new ScrollView(document, { follow: "end", primary: true, virtualize: true });
	const layout = renderLayoutFrame(scroll, 70, 20, () => {});
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
				getBounds: () => undefined,
			}),
		},
		(text) => text,
	);
	return { scroll, search, layout, renders: () => renders };
}

test("opening, refreshing, clearing and closing an empty search do not measure hidden transcript entries", () => {
	const view = fixture();
	try {
		const before = view.renders();
		view.search.toggleSearch();
		assert.equal(view.renders(), before);
		assert.equal(view.search.refreshSearch(view.layout), false);
		view.search.activeSearch!.component.handleInput(" ");
		assert.equal(view.search.refreshSearch(view.layout), false);
		view.search.activeSearch!.component.handleInput("\x7f");
		assert.equal(view.search.refreshSearch(view.layout), false);
		view.search.closeSearch();
		assert.equal(view.renders(), before);
		assert.equal(view.search.activeSearch, undefined);
	} finally {
		view.scroll.detach();
	}
});

async function finishSearch(view: ReturnType<typeof fixture>, width = 70) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		const layout = renderLayoutFrame(view.scroll, width, 20, () => {});
		view.search.refreshSearch(layout);
		const active = view.search.activeSearch;
		if (view.scroll.isContentSettled && active?.matches.length) return layout;
	}
	assert.fail("search did not complete after background measurement");
}

test("the first nonempty query yields measurement, then searches hidden entries exactly", async () => {
	const view = fixture();
	try {
		view.search.toggleSearch();
		const before = view.renders();
		view.search.activeSearch!.component.handleInput("entry 7:");
		assert.equal(view.renders(), before);
		view.search.refreshSearch(view.layout);
		assert.equal(view.renders(), before);
		assert.equal(view.search.activeSearch!.matches.length, 0);
		await finishSearch(view);
		assert.equal(view.search.activeSearch!.matches.length, 1);
		assert.ok(view.scroll.scrollTop < view.search.activeSearch!.anchorRow);
		assert.ok(renderLayoutFrame(view.scroll, 70, 20, () => {}).lines.some((line) => line.includes("entry 7:")));
	} finally {
		view.scroll.detach();
	}
});

test("query replacement during resize produces the exact new-width matches and navigation", async () => {
	const view = fixture();
	try {
		view.search.toggleSearch();
		view.search.activeSearch!.component.handleInput("entry 7:");
		await finishSearch(view);
		const resized = renderLayoutFrame(view.scroll, 41, 20, () => {});
		view.search.refreshSearch(resized);
		view.search.activeSearch!.component.handleInput("\x15");
		view.search.activeSearch!.component.handleInput("entry 2");
		const layout = await finishSearch(view, 41);
		const expected = findAltScreenSearchMatches(getScrollViewBox(layout, view.scroll)!.scrollContentLines!, "entry 2");
		assert.deepEqual(view.search.activeSearch!.matches, expected);
		const selected = view.search.activeSearch!.selectedIndex;
		view.search.navigateSearch(1);
		view.search.refreshSearch(layout);
		assert.equal(view.search.activeSearch!.selectedIndex, (selected + 1) % expected.length);
		view.search.navigateSearch(-1);
		view.search.refreshSearch(layout);
		assert.equal(view.search.activeSearch!.selectedIndex, selected);
	} finally {
		view.scroll.detach();
	}
});

test("closing and detaching while a query waits cancels background measurement", async () => {
	const view = fixture();
	view.search.toggleSearch();
	view.search.activeSearch!.component.handleInput("entry 7:");
	view.search.refreshSearch(view.layout);
	view.search.closeSearch();
	view.scroll.detach();
	const before = view.renders();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(view.renders(), before);
	assert.equal(view.search.activeSearch, undefined);
});
