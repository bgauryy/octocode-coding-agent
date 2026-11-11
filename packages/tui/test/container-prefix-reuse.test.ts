import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { Container, type Component, type TuiMouseEvent } from "../src/tui.ts";
import { LayoutRecorder, recordLayout } from "../src/tui/layout-recorder.ts";

/** Returns the same array until its rows change, like a cached component. */
class Rows implements Component {
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	set(lines: string[]): void {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Returns a new array on every call, like a component with no cache. */
class Fresh implements Component {
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

/** Rows whose elements count every read, to prove which children's rows a frame copied. */
function trackedRows(prefix: string, length: number, counter: { reads: number }): string[] {
	const lines: string[] = [];
	for (let index = 0; index < length; index++) {
		const value = `${prefix}${index}`;
		Object.defineProperty(lines, index, {
			enumerable: true,
			get: () => {
				counter.reads++;
				return value;
			},
		});
	}
	return lines;
}

/** The full concatenation the container must equal: every child's rows in order. */
function concatenate(container: Container, width: number): string[] {
	return container.children.flatMap((child) =>
		child instanceof Container ? concatenate(child, width) : child.render(width),
	);
}

/** Deterministic pseudo-random sequence so a failure reproduces. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

const click = (y: number, width = 40): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x: 0,
	y,
	screenX: 0,
	screenY: y,
	width,
	height: 1_000,
	shift: false,
	alt: false,
	ctrl: false,
	clickCount: 1,
});

describe("Container prefix reuse", () => {
	it("equals the full concatenation through random edits, nesting, widths and large children", () => {
		const next = random(7);
		const root = new Container();
		const inner = new Container();
		root.addChild(inner);
		let serial = 0;
		const make = (): Component => {
			serial++;
			const roll = next();
			if (roll < 0.15) return new Fresh(`fresh ${serial}`);
			// Some children cross the bulk-copy threshold.
			const length = roll < 0.25 ? 1_500 : Math.floor(next() * 4);
			return new Rows(Array.from({ length }, (_, row) => `c${serial}:${row}`));
		};
		for (let index = 0; index < 20; index++) (next() < 0.3 ? inner : root).addChild(make());
		let width = 40;
		for (let step = 0; step < 400; step++) {
			const target = next() < 0.3 ? inner : root;
			const roll = next();
			const position = Math.floor(next() * (target.children.length + 1));
			if (roll < 0.3) {
				const child = target.children[Math.min(position, target.children.length - 1)];
				if (child instanceof Rows) child.set([...child.render(), `edit ${step}`].slice(-Math.ceil(next() * 4)));
			} else if (roll < 0.45) target.children.splice(position, 0, make());
			else if (roll < 0.6 && target.children.length > 1) target.children.splice(position, 1);
			else if (roll < 0.65) target.clear();
			else if (roll < 0.7) width = 30 + Math.floor(next() * 20);
			else if (roll < 0.75) root.invalidate();
			const before = root.render(width);
			const snapshot = before.slice();
			assert.deepEqual(before, concatenate(root, width), `step ${step}`);
			const again = root.render(width);
			if (!root.children.some((child) => child instanceof Fresh) && !inner.children.some((c) => c instanceof Fresh))
				assert.equal(again, before, `unchanged frame keeps identity at step ${step}`);
			assert.deepEqual(before, snapshot, `a later frame never mutates an earlier result at step ${step}`);
		}
	});

	it("copies a changed tail without reading the rows of the children before it", () => {
		const counter = { reads: 0 };
		const container = new Container();
		for (let index = 0; index < 50; index++) container.addChild(new Rows(trackedRows(`m${index}:`, 20, counter)));
		const tail = new Rows(["tail 0"]);
		container.addChild(tail);
		const first = container.render(40);
		assert.equal(first.length, 1_001);
		counter.reads = 0;

		tail.set(["tail 1", "tail 1b"]);
		const second = container.render(40);
		assert.equal(counter.reads, 0);
		assert.notEqual(second, first);
		assert.deepEqual(second.slice(-3), ["m49:19", "tail 1", "tail 1b"]);
		assert.equal(second.length, 1_002);

		container.addChild(new Rows(["appended"]));
		const third = container.render(40);
		assert.equal(counter.reads, 0);
		assert.deepEqual(third.slice(-2), ["tail 1b", "appended"]);
	});

	it("reads only the rows from the first changed child on", () => {
		const early = { reads: 0 };
		const late = { reads: 0 };
		const container = new Container();
		container.addChild(new Rows(trackedRows("a", 10, early)));
		const middle = new Rows(["middle"]);
		container.addChild(middle);
		container.addChild(new Rows(trackedRows("z", 10, late)));
		container.render(40);
		early.reads = 0;
		late.reads = 0;
		middle.set(["middle changed"]);
		const lines = container.render(40);
		assert.equal(early.reads, 0);
		assert.equal(late.reads, 10);
		assert.deepEqual(lines.slice(9, 12), ["a9", "middle changed", "z0"]);
	});

	it("reports every child to the layout recorder on a changed-tail frame", () => {
		const container = new Container();
		const children = [new Rows(["a", "b"]), new Rows(["c"]), new Rows(["d"])];
		for (const child of children) container.addChild(child);
		container.render(40);
		children[2].set(["d", "e"]);
		const recorder = new LayoutRecorder();
		recordLayout(recorder, () => container.render(40));
		assert.deepEqual(
			recorder.leaves.map((leaf) => [leaf.component, leaf.start, leaf.length]),
			[
				[children[0], 0, 2],
				[children[1], 2, 1],
				[children[2], 3, 2],
			],
		);
	});

	it("routes clicks by the painted rows after a changed tail", () => {
		const clicked: string[] = [];
		const clickable = (name: string, lines: string[]): Rows & Component => {
			const rows = new Rows(lines) as Rows & Component;
			rows.handleMouse = () => {
				clicked.push(name);
				return { handled: true };
			};
			return rows;
		};
		const container = new Container();
		container.addChild(clickable("first", ["1", "2"]));
		const tail = clickable("tail", ["3"]);
		container.addChild(tail);
		container.render(40);
		tail.set(["3", "4", "5"]);
		container.render(40);
		container.handleMouse(click(1));
		container.handleMouse(click(4));
		container.handleMouse(click(5));
		assert.deepEqual(clicked, ["first", "tail"]);
	});

	it("paints the same frames as an uncached transcript while the tail streams and the width changes", () => {
		const rows = (index: number) => Array.from({ length: 3 }, (_, row) => `message ${index} row ${row}`);
		const children: Rows[] = Array.from({ length: 300 }, (_, index) => new Rows(rows(index)));
		const transcript = new Container();
		for (const child of children) transcript.addChild(child);
		const layout = (content: Container) =>
			new VStack([
				{ component: new ScrollView(content, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor", 0, 0), basis: 1, grow: 0, shrink: 0 },
			]);
		const cached = layout(transcript);
		const tail = children[children.length - 1];
		for (let frame = 0; frame < 30; frame++) {
			tail.set([...tail.render(), `streamed ${frame}`]);
			const width = frame % 10 === 9 ? 60 : 80;
			const fresh = new Container();
			for (const child of children) fresh.addChild(child);
			const expected = renderLayoutFrame(layout(fresh), width, 12, () => {}).lines;
			assert.deepEqual(renderLayoutFrame(cached, width, 12, () => {}).lines, expected, `frame ${frame}`);
		}
	});
});
