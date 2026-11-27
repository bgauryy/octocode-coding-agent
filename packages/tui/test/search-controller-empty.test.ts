import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { Container } from "../src/tui/container.ts";
import { markFolded } from "../src/utils/row-marks.ts";
import { AltScreenSearchController } from "../src/tui-alt-screen/search-controller.ts";
import { AltScreenSearchComponent, findAltScreenSearchMatches } from "../src/tui-alt-screen/search-index.ts";

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
		{ navigationButton: (text) => text },
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
		// The last complete matches stay highlighted while a search still runs: only a finished one counts.
		const running = active?.component.render(width).join("\n").includes("Searching");
		if (view.scroll.isContentSettled && active?.matches.length && !running) return layout;
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

test("a whitespace-only query shows no result text, not No matches", () => {
	const component = new AltScreenSearchComponent(() => {});
	component.handleInput(" ");
	component.setResult(-1, 0);
	const text = component.render(40).join("\n");
	assert.ok(!text.includes("No matches"), text);
	component.handleInput("x");
	assert.ok(component.render(40).join("\n").includes("No matches"));
});

test("a search without matches says collapsed blocks were not searched, only when the transcript has one", async () => {
	const document = new Container();
	document.addChild(new Text("visible row", 0, 0));
	const folded = new Text(`… 3 lines hidden ${markFolded("(ctrl+o to expand)")}`, 0, 0);
	document.addChild(folded);
	const scroll = new ScrollView(document, { follow: "end", primary: true });
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
		{ navigationButton: (text) => text },
	);
	try {
		search.toggleSearch();
		search.activeSearch!.component.handleInput("absent");
		search.refreshSearch(renderLayoutFrame(scroll, 100, 20, () => {}));
		assert.match(search.activeSearch!.component.render(100).join("\n"), /No matches · collapsed blocks not searched/);
		document.removeChild(folded);
		search.refreshSearch(renderLayoutFrame(scroll, 100, 20, () => {}));
		const text = search.activeSearch!.component.render(100).join("\n");
		assert.ok(text.includes("No matches") && !text.includes("collapsed"), text);
	} finally {
		scroll.detach();
	}
});

test("an unsettled layout keeps the last complete matches and never shows a frozen 0% search", async () => {
	const view = fixture();
	try {
		view.search.toggleSearch();
		view.search.activeSearch!.component.handleInput("entry 7:");
		await finishSearch(view);
		const search = view.search.activeSearch!;
		const before = search.matches;
		assert.ok(before.length > 0);
		const resized = renderLayoutFrame(view.scroll, 41, 20, () => {});
		assert.equal(view.scroll.isContentSettled, false, "the resize leaves hidden rows unmeasured");
		view.search.refreshSearch(resized);
		assert.equal(search.matches, before);
		const text = search.component.render(40).join("\n");
		assert.ok(!text.includes("0%"), text);
		assert.ok(text.includes("Searching"), text);
	} finally {
		view.scroll.detach();
	}
});
