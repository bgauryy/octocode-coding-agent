import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { LayoutFrame } from "../src/layout/types.ts";
import { getLayoutBoxesAt, getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { registerKittyImageMetadata } from "../src/terminal-image/kitty-metadata.ts";
import type { Component } from "../src/tui/component.ts";
import { Container } from "../src/tui/container.ts";
import { AltScreenSearchController } from "../src/tui-alt-screen/search-controller.ts";
import { applySelectionToScreen, getSelectionText } from "../src/tui-alt-screen/selection.ts";

const OSC133 = "\x1b]133;A\x07";

/** A transcript entry: wrapped words, optionally a prompt mark, a Kitty image and trailing blank rows. */
class Item implements Component {
	/** Busy time per uncached render, so measuring the rest takes several frames' budgets. */
	static costMs = 0;
	renders = 0;
	text: string;
	readonly mark: boolean;
	readonly image: number | undefined;
	readonly blanks: number;

	constructor(text: string, options: { mark?: boolean; image?: number; blanks?: number } = {}) {
		this.text = text;
		this.mark = options.mark ?? false;
		this.image = options.image;
		this.blanks = options.blanks ?? 0;
	}

	private cache?: { width: number; text: string; lines: string[] };

	render(width: number): string[] {
		this.renders++;
		if (this.cache?.width === width && this.cache.text === this.text) return this.cache.lines;
		for (const start = performance.now(); performance.now() - start < Item.costMs;);
		const lines: string[] = [];
		for (let start = 0; start < this.text.length; start += width) lines.push(this.text.slice(start, start + width));
		if (lines.length === 0) lines.push("");
		if (this.mark) lines[0] = `${OSC133}${lines[0]}`;
		if (this.image !== undefined) lines.push(`\x1b_Ga=p,i=${this.image},c=4,r=3;\x1b\\`, "", "");
		for (let blank = 0; blank < this.blanks; blank++) lines.push("");
		this.cache = { width, text: this.text, lines };
		return lines;
	}

	invalidate(): void {}
}

function random(seed: number): (limit: number) => number {
	let state = seed;
	return (limit) => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return Math.floor((state / 2147483648) * limit);
	};
}

const words = (next: (limit: number) => number, count: number) =>
	Array.from({ length: count }, () => ["alpha", "beta", "needle", "gamma", "delta"][next(5)]).join(" ");

type ItemSpec = [text: string, options: { mark?: boolean; image?: number; blanks?: number }];

function newSpec(next: (limit: number) => number): ItemSpec {
	const kind = next(10);
	return [
		words(next, 1 + next(30)),
		{ mark: kind === 0, ...(kind === 1 ? { image: 1 + next(3) } : {}), blanks: kind === 2 ? 2 : 0 },
	];
}

const newItem = (next: (limit: number) => number): Item => new Item(...newSpec(next));

/** The same transcript twice, with separate items, so neither layout's renders warm the other's. */
function twins(specs: ItemSpec[], scrollbar: "hidden" | "auto") {
	const build = (virtualize: boolean) => {
		const chat = new Container();
		for (const spec of specs) chat.addChild(new Item(...spec));
		const document = new Container();
		document.addChild(new Item("header row"));
		document.addChild(chat);
		const scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar, virtualize });
		const dock = { render: () => ["dock one", "dock two"], invalidate() {} };
		return { chat, scroll, root: new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }, dock]) };
	};
	const views = [build(true), build(false)];
	const each = (change: (view: (typeof views)[number]) => void) => views.forEach(change);
	return { virtual: views[0], exact: views[1], each };
}

/** One document, laid out by a virtualized and a plain scroll view of the same options. */
function pair(items: Item[], scrollbar: "hidden" | "auto" = "hidden") {
	const header = new Container();
	const headerItem = new Item("header row");
	header.addChild(headerItem);
	const chat = new Container();
	for (const item of items) chat.addChild(item);
	const document = new Container();
	document.addChild(header);
	document.addChild(chat);
	const dock = { render: () => ["dock one", "dock two"], invalidate() {} };
	const view = (virtualize: boolean) => {
		const scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar, virtualize });
		return { scroll, root: new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }, dock]) };
	};
	return { chat, headerItem, virtual: view(true), exact: view(false) };
}

function frames(
	views: { virtual: { root: Component }; exact: { root: Component } },
	width: number,
	height: number,
): { virtual: LayoutFrame; exact: LayoutFrame } {
	return {
		virtual: renderLayoutFrame(views.virtual.root, width, height, () => {}),
		exact: renderLayoutFrame(views.exact.root, width, height, () => {}),
	};
}

for (const id of [1, 2, 3]) registerKittyImageMetadata({ imageId: id, columns: 4, rows: 3, widthPx: 40, heightPx: 30 });

describe("virtualized scroll view", () => {
	it("paints the viewport exactly as the full layout through resizes, appends, streaming and scrolling", () => {
		// "auto" shows the scrollbar after a scroll (its hide timer does not run here): those frames take the exact path.
		const runs = [
			[3, "hidden", 0],
			[17, "hidden", 0],
			[29, "auto", 0],
			[101, "hidden", 0.08],
		] as const;
		for (const [seed, scrollbar, costMs] of runs) {
			Item.costMs = costMs;
			const next = random(seed);
			const views = twins(
				Array.from({ length: 150 + next(150) }, () => newSpec(next)),
				scrollbar,
			);
			let width = 40;
			let height = 20;
			let virtualFrames = 0;
			for (let step = 0; step < 250; step++) {
				const op = next(12);
				const count = views.exact.chat.children.length;
				const at = next(count);
				const items = ({ chat }: { chat: Container }) => chat.children as Item[];
				if (op <= 2) width = 12 + next(70);
				else if (op === 3) height = 6 + next(30);
				else if (op === 4) {
					const spec = newSpec(next);
					views.each(({ chat }) => chat.addChild(new Item(...spec)));
				} else if (op === 5) {
					const more = ` ${words(next, 1 + next(8))}`;
					views.each((view) => (items(view)[count - 1].text += more));
				} else if (op === 6) views.each((view) => (items(view)[at].text += " edited above"));
				else if (op === 7 && count > 5) views.each(({ chat }) => chat.removeChild(chat.children[at]));
				else if (op === 8) {
					const rows = next(2) === 0 ? -(1 + next(40)) : 1 + next(40);
					views.each(({ scroll }) => scroll.scrollBy(rows));
				} else if (op === 9) views.each(({ scroll }) => scroll.scrollToEnd());
				else if (op === 10 && next(4) === 0) views.each(({ scroll }) => scroll.scrollToStart());
				const { virtual, exact } = frames(views, width, height);
				const box = getScrollViewBox(virtual, views.virtual.scroll);
				if (box?.materialize) virtualFrames++;
				assert.deepStrictEqual(virtual.lines, exact.lines, `seed ${seed}, step ${step}`);
				if (op === 11 && box) {
					// Search and selection read the whole content: it matches, and the position becomes exact.
					assert.deepStrictEqual(
						box.scrollContentLines,
						getScrollViewBox(exact, views.exact.scroll)?.scrollContentLines,
					);
					assert.strictEqual(views.virtual.scroll.scrollTop, views.exact.scroll.scrollTop);
				}
			}
			assert.ok(virtualFrames > (scrollbar === "auto" ? 0 : 20), `seed ${seed}: ${virtualFrames} virtualized frames`);
			// Once measured, the positions agree too.
			const { virtual, exact } = frames(views, width, height);
			assert.deepStrictEqual(virtual.lines, exact.lines);
			views.virtual.scroll.settleContent();
			assert.strictEqual(views.virtual.scroll.scrollTop, views.exact.scroll.scrollTop);
			assert.deepStrictEqual(frames(views, width, height).virtual.lines, exact.lines);
		}
		Item.costMs = 0;
	});

	it("renders only the rows in view on a width change and reaches every item for the pointer", () => {
		const next = random(7);
		const items = Array.from({ length: 400 }, () => newItem(next));
		const views = pair(items);
		frames(views, 50, 20);
		for (const item of items) item.renders = 0;
		const virtual = renderLayoutFrame(views.virtual.root, 61, 20, () => {});
		const rendered = items.filter((item) => item.renders > 0).length;
		assert.ok(rendered < 20, `${rendered} items rendered`);

		// Each viewport row's deepest box is the item a full layout shows on that row.
		const exactLines = views.exact.scroll.render(61);
		const scrollTop = exactLines.length - 18;
		const owners: Component[] = [];
		for (const item of [views.headerItem, ...items]) {
			for (let row = 0; row < item.render(61).length; row++) owners.push(item);
		}
		assert.strictEqual(owners.length, exactLines.length);
		for (let row = 0; row < 18; row++) {
			assert.strictEqual(getLayoutBoxesAt(virtual, 3, row)[0]?.component, owners[scrollTop + row], `row ${row}`);
		}
	});

	it("lets the transcript container drop its joined copy of every row while frames draw items one by one", () => {
		const next = random(11);
		const specs = Array.from({ length: 300 }, () => newSpec(next));
		const { virtual, exact } = twins(specs, "hidden");
		const joined = (container: Container) => (container as unknown as { renderCache?: unknown }).renderCache;
		const exactFrame = renderLayoutFrame(exact.root, 50, 20, () => {});
		// A width change leaves most items unmeasured, so the frame is virtualized.
		renderLayoutFrame(virtual.root, 61, 20, () => {});
		const virtualFrame = renderLayoutFrame(virtual.root, 50, 20, () => {});
		assert.strictEqual(joined(virtual.chat), undefined, "no joined rows retained");
		assert.notStrictEqual(joined(exact.chat), undefined);
		assert.deepStrictEqual(virtualFrame.lines, exactFrame.lines);
		// A full layout joins them again and paints the same rows.
		virtual.scroll.scrollBy(-40);
		exact.scroll.scrollBy(-40);
		assert.deepStrictEqual(
			renderLayoutFrame(virtual.root, 50, 20, () => {}).lines,
			renderLayoutFrame(exact.root, 50, 20, () => {}).lines,
		);
	});

	it("finds search matches and selects rows in items never rendered at this width", () => {
		const items = Array.from({ length: 300 }, (_, index) => new Item(`entry ${index} ${"filler ".repeat(10)}`));
		items[5].text = "the needle is far above the viewport";
		const views = pair(items);
		frames(views, 50, 20);
		for (const item of items) item.renders = 0;
		const virtual = renderLayoutFrame(views.virtual.root, 70, 20, () => {});
		assert.strictEqual(items[5].renders, 0);
		const exact = renderLayoutFrame(views.exact.root, 70, 20, () => {});
		const box = getScrollViewBox(virtual, views.virtual.scroll);
		const lines = box?.scrollContentLines ?? [];
		const needleRow = lines.findIndex((line) => line.includes("needle"));
		assert.ok(needleRow > 0 && needleRow < views.virtual.scroll.scrollTop);
		assert.deepStrictEqual(lines, getScrollViewBox(exact, views.exact.scroll)?.scrollContentLines);
		assert.strictEqual(views.virtual.scroll.scrollTop, views.exact.scroll.scrollTop);
	});

	it("search finds and reveals a match in an item the virtualized frame never rendered", () => {
		const items = Array.from({ length: 300 }, (_, index) => new Item(`entry ${index} ${"filler ".repeat(10)}`));
		items[7].text = "the needle is far above the viewport";
		const views = pair(items);
		frames(views, 50, 20);
		for (const item of items) item.renders = 0;
		let layout = renderLayoutFrame(views.virtual.root, 70, 20, () => {});
		assert.strictEqual(items[7].renders, 0);
		const scroll = views.virtual.scroll;
		const search = new AltScreenSearchController(
			{
				implicitScrollView: scroll,
				getPrimaryScrollView: () => scroll,
				showOverlay: () => ({
					hide() {},
					setHidden() {},
					isHidden: () => false,
					focus() {},
					unfocus() {},
					isFocused: () => false,
					getBounds: () => undefined,
				}),
				requestRender() {},
			},
			(text) => text,
		);
		search.toggleSearch();
		const active = search.activeSearch;
		assert.ok(active);
		active.query = "needle";
		assert.strictEqual(search.refreshSearch(layout), true);
		assert.strictEqual(active.matches.length, 1);
		layout = renderLayoutFrame(views.virtual.root, 70, 20, () => {});
		assert.ok(layout.lines.some((line) => line.includes("the needle is far above")));
	});

	it("selects rows that span items out of view and never rendered at this width", () => {
		const items = Array.from({ length: 300 }, (_, index) => new Item(`entry ${index}`));
		const views = pair(items);
		frames(views, 50, 20);
		for (const item of items) item.renders = 0;
		const layout = renderLayoutFrame(views.virtual.root, 70, 20, () => {});
		const scroll = views.virtual.scroll;
		const selection = {
			start: { row: 1, col: 0, scrollView: scroll },
			end: { row: 290, col: 20, scrollView: scroll, boundary: true },
		};
		// Highlighting first settles the position, so the rows in view are the selection's last ones.
		const screen = applySelectionToScreen(layout.lines, selection, layout, 70);
		assert.notDeepStrictEqual(screen, layout.lines);
		const text = getSelectionText(selection, [], layout);
		const expected = Array.from({ length: 290 }, (_, index) => `entry ${index}`).join("\n");
		assert.strictEqual(text, expected);
	});
});
