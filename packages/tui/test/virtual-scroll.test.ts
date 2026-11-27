import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { getScrollbarGeometry } from "../src/layout/scrollbar.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { LayoutBox, LayoutFrame } from "../src/layout/types.ts";
import { VirtualDocument } from "../src/layout/virtual-document.ts";
import { getLayoutBoxesAt, getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { registerKittyImageMetadata } from "../src/terminal-image/kitty-metadata.ts";
import type { Component } from "../src/tui/component.ts";
import { Container } from "../src/tui/container.ts";
import { renderChanged, renderTrack, trackRenderChanges } from "../src/tui/render-signal.ts";
import { AltScreenSearchController } from "../src/tui-alt-screen/search-controller.ts";
import { applySelectionToScreen, getSelectionText, scrollScrollbarToPointer } from "../src/tui-alt-screen/selection.ts";

const OSC133 = "\x1b]133;A\x07";

/** A transcript entry: wrapped words, optionally a prompt mark, a Kitty image and trailing blank rows. */
class Item implements Component {
	/** Busy time per uncached render, so measuring the rest takes several frames' budgets. */
	static costMs = 0;
	renders = 0;
	#text = "";
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

	get text(): string {
		return this.#text;
	}

	/** Editing the text signals the change, as a tracked component must (an untracked one is rendered every frame). */
	set text(text: string) {
		this.#text = text;
		renderChanged(this);
	}

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

/** An item whose rows change only with a signal: frames skip it until it signals. */
class TrackedItem extends Item {
	override render(width: number): string[] {
		return super.render(width);
	}
}
trackRenderChanges(TrackedItem.prototype);

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
function twins(specs: ItemSpec[], scrollbar: "hidden" | "auto", Kind: typeof Item = Item) {
	const build = (virtualize: boolean) => {
		const chat = new Container();
		for (const spec of specs) chat.addChild(new Kind(...spec));
		const document = new Container();
		const header = new Item("header row");
		document.addChild(header);
		document.addChild(chat);
		const scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar, virtualize });
		const dock = { render: () => ["dock one", "dock two"], invalidate() {} };
		const root = new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }, dock]);
		return { chat, scroll, root, items: (): Component[] => [header, ...chat.children] };
	};
	const views = [build(true), build(false)];
	const each = (change: (view: (typeof views)[number]) => void) => views.forEach(change);
	return { virtual: views[0], exact: views[1], each, Kind };
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

/**
 * Random edits, resizes and scrolls applied to a virtualized view and its exact twin; every frame must paint exactly
 * what the twin paints. Following the end, the twin is compared as it is. Above the end the virtualized view keeps the
 * item at the top of the view across width changes, where the twin keeps the row number, so the twin is first scrolled
 * to the row the virtualized frame shows, found from the exact heights of the items above it.
 */
function runDifferential(
	seed: number,
	scrollbar: "hidden" | "auto",
	costMs: number,
	tracked = false,
): { virtualFrames: number; anchoredFrames: number } {
	Item.costMs = costMs;
	try {
		const next = random(seed);
		const views = twins(
			Array.from({ length: 150 + next(150) }, () => newSpec(next)),
			scrollbar,
			tracked ? TrackedItem : Item,
		);
		let width = 40;
		let height = 20;
		let virtualFrames = 0;
		let anchoredFrames = 0;
		/** The exact row at the top of the view after the last step; -1 while following the end. */
		let shownBefore = -1;
		for (let step = 0; step < 250; step++) {
			const op = next(12);
			const count = views.exact.chat.children.length;
			// A width change above the end keeps the item at the top of the view, at the same row within it.
			const kept =
				op <= 2 && !views.virtual.scroll.isFollowingEnd
					? itemAtRow(views.exact.items(), shownBefore, width)
					: undefined;
			const at = next(count);
			const items = ({ chat }: { chat: Container }) => chat.children as Item[];
			if (op <= 2) width = 12 + next(70);
			else if (op === 3) height = 6 + next(30);
			else if (op === 4) {
				const spec = newSpec(next);
				views.each(({ chat }) => chat.addChild(new views.Kind(...spec)));
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
			const { virtual } = frames(views, width, height);
			let exact = renderLayoutFrame(views.exact.root, width, height, () => {});
			const box = getScrollViewBox(virtual, views.virtual.scroll);
			if (box?.materialize) virtualFrames++;
			let shownTop: number | undefined;
			if (!views.virtual.scroll.isFollowingEnd && box) {
				shownTop = box.materialize ? anchoredTop(box, views.virtual.items(), views.exact.items(), width) : undefined;
				if (shownTop !== undefined) anchoredFrames++;
				views.exact.scroll.scrollTo(shownTop ?? views.virtual.scroll.scrollTop, { disableFollow: true });
				exact = renderLayoutFrame(views.exact.root, width, height, () => {});
				if (kept) {
					const items = views.exact.items();
					let expected = 0;
					for (let item = 0; item < kept.index; item++) expected += items[item].render(width).length;
					expected += Math.min(kept.offset, Math.max(0, items[kept.index].render(width).length - 1));
					const atEnd = views.exact.scroll.scrollTop >= exactMaxScrollTop(views.exact.items(), width, height);
					if (!atEnd)
						assert.strictEqual(views.exact.scroll.scrollTop, expected, `seed ${seed}, step ${step}: top item kept`);
				}
			} else if (!views.exact.scroll.isFollowingEnd) {
				// The twin was last placed above the end with following off: the virtualized view follows the end again.
				views.exact.scroll.scrollToEnd();
				exact = renderLayoutFrame(views.exact.root, width, height, () => {});
			}
			// Unmeasured history changes thumb geometry, never the visible transcript.
			assert.deepStrictEqual(transcriptRows(virtual.lines), transcriptRows(exact.lines), `seed ${seed}, step ${step}`);
			shownBefore = views.virtual.scroll.isFollowingEnd ? -1 : views.exact.scroll.scrollTop;
			if (shownTop !== undefined && op !== 11 && next(3) === 0) {
				// Measuring the rest keeps the rows in view: the position becomes the exact row the frame showed.
				box?.materialize?.();
				assert.strictEqual(views.virtual.scroll.scrollTop, shownTop, `seed ${seed}, step ${step}: settled position`);
			}
			if (op === 11 && box) {
				// Search and selection read the whole content: it matches, and the position becomes exact.
				assert.deepStrictEqual(box.scrollContentLines, getScrollViewBox(exact, views.exact.scroll)?.scrollContentLines);
				assert.strictEqual(views.virtual.scroll.scrollTop, views.exact.scroll.scrollTop, `seed ${seed}, step ${step}`);
			}
		}
		// Once measured, the positions agree too.
		views.virtual.scroll.settleContent();
		const virtual = renderLayoutFrame(views.virtual.root, width, height, () => {});
		if (views.virtual.scroll.isFollowingEnd) views.exact.scroll.scrollToEnd();
		else views.exact.scroll.scrollTo(views.virtual.scroll.scrollTop, { disableFollow: true });
		assert.deepStrictEqual(virtual.lines, renderLayoutFrame(views.exact.root, width, height, () => {}).lines);
		return { virtualFrames, anchoredFrames };
	} finally {
		Item.costMs = 0;
	}
}

/** The item holding exact row `row` and the row within it. */
function itemAtRow(items: Component[], row: number, width: number): { index: number; offset: number } | undefined {
	if (row < 0) return undefined;
	let top = 0;
	for (let index = 0; index < items.length; index++) {
		const height = items[index].render(width).length;
		if (row < top + height) return { index, offset: row - top };
		top += height;
	}
	return undefined;
}

function transcriptRows(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(/\x1b\[0m(?:\x1b\[2m│\x1b\[22m|┃)$/, ""));
}

function exactMaxScrollTop(items: Component[], width: number, height: number): number {
	let total = 0;
	for (const item of items) total += item.render(width).length;
	// The dock below the scroll view takes two rows.
	return Math.max(0, total - (height - 2));
}

/** The exact content row a virtualized frame shows at the top of the view: its first item, placed among exact heights. */
function anchoredTop(box: LayoutBox, items: Component[], twinItems: Component[], width: number): number | undefined {
	const documentBox = box.children[0];
	const first = documentBox?.children.find((child) => child.rect.y + child.rect.height > box.rect.y);
	if (!first) return undefined;
	const index = items.indexOf(first.component);
	let top = 0;
	for (let item = 0; item < index; item++) top += twinItems[item].render(width).length;
	return top + (box.rect.y - first.rect.y);
}

describe("virtualized scroll view", () => {
	it("releases measured row subscriptions when rows leave and measures them again if they return", () => {
		const root = new Container();
		const row = new TrackedItem("one");
		root.addChild(row);
		const document = new VirtualDocument(root);
		document.prepare(root, 5);
		document.measure(0);
		const withDocument = renderTrack(row).parents!.length;
		root.removeChild(row);
		document.prepare(root, 5);
		assert.strictEqual(renderTrack(row).parents?.length, withDocument - 2);
		row.text = "a much longer replacement";
		root.addChild(row);
		document.prepare(root, 5);
		assert.ok(document.isPending(0));
		assert.deepStrictEqual(document.measure(0).lines, row.render(5));
		document.dispose();
	});

	it("keeps row subscription counts flat across repeated mount, exact layout, and detach", () => {
		const content = new Container();
		const items = Array.from({ length: 100 }, (_, index) => new TrackedItem(`row ${index}`));
		for (const row of items) content.addChild(row);
		const scroll = new ScrollView(content, { virtualize: true, follow: "end" });
		// One warm layout establishes the container's own subscriptions.
		renderLayoutFrame(scroll, 40, 10, () => {});
		scroll.settleContent();
		renderLayoutFrame(scroll, 40, 10, () => {});
		scroll.detach();
		const baseline = items.map((row) => renderTrack(row).parents?.length ?? 0);
		assert.ok(baseline.every((count) => count === 1));
		for (let cycle = 0; cycle < 20; cycle++) {
			renderLayoutFrame(scroll, 40, 10, () => {});
			if (cycle % 2 === 0) {
				scroll.settleContent();
				renderLayoutFrame(scroll, 40, 10, () => {});
			}
			scroll.detach();
			scroll.detach();
			assert.deepStrictEqual(
				items.map((row) => renderTrack(row).parents?.length ?? 0),
				baseline,
			);
		}
	});

	it("spends the existing measurement budget on nearby rows in the scroll direction first", () => {
		const measured: number[] = [];
		const content = new Container();
		for (let index = 0; index < 500; index++) {
			content.addChild({
				render: () => {
					measured.push(index);
					return [`item ${index}`];
				},
				invalidate() {},
			});
		}
		const doc = new VirtualDocument(content);
		doc.prepare(content, 80);
		doc.prioritize(200, 219, 20);
		doc.measurePending(200, Number.NEGATIVE_INFINITY, 1);
		assert.deepEqual(measured, [220]);
		doc.prioritize(180, 199, 20);
		doc.measurePending(180, Number.NEGATIVE_INFINITY, 1);
		assert.deepEqual(measured, [220, 179]);
		assert.strictEqual(doc.pendingCount, 498);
		// Nearby work cannot starve the rest or leave a duplicate entry pending forever.
		doc.measurePending(180, Number.POSITIVE_INFINITY);
		assert.strictEqual(doc.pendingCount, 0);
		assert.strictEqual(new Set(measured).size, 500);
		assert.strictEqual(measured.length, 500);
	});

	for (const scrollbar of ["auto", "always"] as const) {
		it(`keeps ${scrollbar} scrollbar scrolling, resizing and dragging within the measurement budget`, () => {
			Item.costMs = 0.1;
			const content = new Container();
			const items = Array.from(
				{ length: 2000 },
				(_, index) => new TrackedItem(`entry ${index} ${"filler ".repeat(15)}`),
			);
			for (const item of items) content.addChild(item);
			const scroll = new ScrollView(content, { scrollbar, virtualize: true, follow: "end" });
			try {
				let frame = renderLayoutFrame(scroll, 50, 20, () => {});
				for (const action of ["scroll", "resize", "drag", "start"] as const) {
					for (const item of items) item.renders = 0;
					if (action === "scroll") scroll.scrollBy(-10);
					if (action === "drag") {
						const geometry = getScrollbarGeometry(getScrollViewBox(frame, scroll)!)!;
						scrollScrollbarToPointer(scroll, geometry, 8, 0);
					}
					if (action === "start") scroll.scrollToStart();
					frame = renderLayoutFrame(scroll, action === "scroll" ? 50 : 61, 20, () => {});
					assert.equal(scroll.isScrollbarVisible, true);
					const rendered = items.filter((item) => item.renders > 0).length;
					assert.ok(rendered < 200, `${action} rendered ${rendered} items`);
					const before = transcriptRows(frame.lines);
					// Settling must keep the message and row the estimated position selected.
					scroll.settleContent();
					assert.deepStrictEqual(
						transcriptRows(renderLayoutFrame(scroll, action === "scroll" ? 50 : 61, 20, () => {}).lines),
						before,
					);
					// Invalidate the width so the next action has unmeasured history again.
					frame = renderLayoutFrame(scroll, action === "scroll" ? 50 : 62, 20, () => {});
				}
			} finally {
				scroll.detach();
				Item.costMs = 0;
			}
		});
	}

	it("cancels detached history measurement and resumes it on the next layout", async () => {
		const content = new Container();
		const items = Array.from({ length: 2000 }, (_, index) => new TrackedItem(`entry ${index}`));
		for (const item of items) content.addChild(item);
		const scroll = new ScrollView(content, { virtualize: true, follow: "end" });
		renderLayoutFrame(scroll, 40, 10, () => {});
		scroll.detach();
		const renders = () => items.reduce((sum, item) => sum + item.renders, 0);
		const before = renders();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(renders(), before);
		renderLayoutFrame(scroll, 40, 10, () => {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(renders() > before);
		scroll.detach();
	});

	it("paints the viewport exactly as the full layout through resizes, appends, streaming and scrolling", () => {
		// Auto scrollbars remain visible after scrolling throughout this synchronous differential run.
		const runs = [
			[3, "hidden", 0, false],
			[17, "hidden", 0, false],
			[29, "auto", 0, false],
			[101, "hidden", 0.08, false],
			[3, "hidden", 0, true],
			[211, "hidden", 0, true],
			[307, "hidden", 0, true],
			[29, "auto", 0, true],
			[101, "hidden", 0.08, true],
		] as const;
		for (const [seed, scrollbar, costMs, tracked] of runs) {
			const { virtualFrames, anchoredFrames } = runDifferential(seed, scrollbar, costMs, tracked);
			assert.ok(virtualFrames > 20, `seed ${seed}: ${virtualFrames} virtualized frames`);
			assert.ok(anchoredFrames > 0, `seed ${seed}: no frame anchored above the end`);
		}
	});

	it("fails the differential run when the measuring queue is broken (the check can fail)", () => {
		const proto = VirtualDocument.prototype as unknown as Record<string, (...args: never[]) => unknown>;
		const breaks: Array<[name: string, broken: (this: never, ...args: never[]) => unknown]> = [
			// Items taken off the queue without measuring: estimates count as measured heights.
			[
				"measurePending",
				function (this: { pending: number[]; pendingFlags: Uint8Array; pendingCount: number }) {
					for (const index of this.pending) if (this.pendingFlags[index] === 1) this.pendingFlags[index] = 0;
					this.pending = [];
					this.pendingCount = 0;
					return 0;
				},
			],
		];
		for (const [name, broken] of breaks) {
			const original = proto[name];
			proto[name] = broken;
			try {
				let failures = 0;
				for (const seed of [3, 211, 307]) {
					try {
						runDifferential(seed, "hidden", 0, true);
					} catch {
						failures++;
					}
				}
				assert.ok(failures > 0, `broken ${name} went unnoticed`);
			} finally {
				proto[name] = original;
			}
		}
	});

	it("keeps the rows in view when an item above them changes after it was measured", () => {
		const settled = (dropChanges: boolean): void => {
			const proto = VirtualDocument.prototype as unknown as { absorbDirty(): void };
			const absorb = proto.absorbDirty;
			if (dropChanges)
				proto.absorbDirty = function (this: { dirty: Set<Component> }) {
					this.dirty.clear();
				};
			Item.costMs = 0.2;
			try {
				const next = random(41);
				const views = twins(
					Array.from({ length: 400 }, () => newSpec(next)),
					"hidden",
					TrackedItem,
				);
				frames(views, 50, 20);
				views.each(({ scroll }) => scroll.scrollTo(600));
				frames(views, 50, 20);
				// Scrolled up, the width changes: the item at the top of the view stays there, the rest is unmeasured.
				views.virtual.scroll.scrollBy(0);
				renderLayoutFrame(views.virtual.root, 61, 20, () => {});
				// A frame 12 rows higher draws (and so measures) the items there; back down, one of them grows above the view.
				views.virtual.scroll.scrollBy(-12);
				const higher = getScrollViewBox(
					renderLayoutFrame(views.virtual.root, 61, 20, () => {}),
					views.virtual.scroll,
				);
				views.virtual.scroll.scrollBy(12);
				const above = higher?.children[0]?.children.find((item) => item.rect.y + item.rect.height <= 12);
				assert.ok(above, "an item drawn above the view");
				const index = views.virtual.items().indexOf(above.component);
				const grow = " grown above the view".repeat(9);
				(views.virtual.items()[index] as Item).text += grow;
				(views.exact.items()[index] as Item).text += grow;
				const virtual = renderLayoutFrame(views.virtual.root, 61, 20, () => {});
				const box = getScrollViewBox(virtual, views.virtual.scroll);
				assert.ok(box?.materialize, "the frame is virtualized");
				const shownTop = anchoredTop(box, views.virtual.items(), views.exact.items(), 61);
				assert.ok(shownTop !== undefined);
				// The plain twin takes the width change first (it anchors its top item), then goes to the same row.
				renderLayoutFrame(views.exact.root, 61, 20, () => {});
				views.exact.scroll.scrollTo(shownTop, { disableFollow: true });
				assert.deepStrictEqual(virtual.lines, renderLayoutFrame(views.exact.root, 61, 20, () => {}).lines);
				box.materialize();
				assert.strictEqual(views.virtual.scroll.scrollTop, shownTop);
			} finally {
				proto.absorbDirty = absorb;
				Item.costMs = 0;
			}
		};
		settled(false);
		assert.throws(() => settled(true), "a change dropped from the queue goes unnoticed");
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

	it("search finds and reveals a match in an item the virtualized frame never rendered", async () => {
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
			{ navigationButton: (text) => text },
		);
		search.toggleSearch();
		const active = search.activeSearch;
		assert.ok(active);
		active.query = "needle";
		assert.strictEqual(search.refreshSearch(layout), false);
		for (let attempt = 0; !scroll.isContentSettled && attempt < 1000; attempt++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		assert.strictEqual(scroll.isContentSettled, true);
		layout = renderLayoutFrame(views.virtual.root, 70, 20, () => {});
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
	it("measures only the items a scroll up reaches; the next frame shows exactly the full layout's rows", () => {
		const next = random(5);
		const items = Array.from({ length: 400 }, () => newItem(next));
		const views = pair(items);
		frames(views, 50, 20);
		// A width change: the frame lays out the rows in view and leaves the rest unmeasured.
		renderLayoutFrame(views.virtual.root, 61, 20, () => {});
		renderLayoutFrame(views.exact.root, 61, 20, () => {});
		for (const item of items) item.renders = 0;
		views.virtual.scroll.scrollBy(-10);
		const measured = items.filter((item) => item.renders > 0).length;
		// Before: the first scroll rendered the whole transcript (every item, twice) before it moved.
		assert.ok(measured < 30, `${measured} items rendered by a 10-row scroll`);
		views.exact.scroll.scrollBy(-10);
		const { virtual, exact } = frames(views, 61, 20);
		assert.deepStrictEqual(virtual.lines, exact.lines);
		assert.strictEqual(views.virtual.scroll.scrollTop, views.exact.scroll.scrollTop);
	});

	it("keeps measuring new items when re-rendering the measured ones alone takes the whole frame budget", () => {
		/** Measured items still cost a little to render again: thousands of them used up the budget every frame. */
		class Busy extends Item {
			override render(width: number): string[] {
				for (const start = performance.now(); performance.now() - start < 0.01;);
				return super.render(width);
			}
		}
		const items = Array.from({ length: 1500 }, (_, index) => new Busy(`entry ${index} ${"filler ".repeat(8)}`));
		const views = pair(items);
		frames(views, 50, 20);
		renderLayoutFrame(views.virtual.root, 61, 20, () => {});
		let virtualFrames = 0;
		while (
			getScrollViewBox(
				renderLayoutFrame(views.virtual.root, 61, 20, () => {}),
				views.virtual.scroll,
			)?.materialize
		) {
			virtualFrames++;
			assert.ok(virtualFrames < 100, "the measure loop stopped making progress");
		}
		assert.deepStrictEqual(
			renderLayoutFrame(views.virtual.root, 61, 20, () => {}).lines,
			renderLayoutFrame(views.exact.root, 61, 20, () => {}).lines,
		);
	});
});
