/**
 * Differential test of render change signals: two identical trees take the same random edits; in one every component
 * takes part in signals (parents skip quiet children), in the other none does (every frame renders every child, as
 * before signals existed). Rows, recorded layouts and the bytes a main-screen TUI writes must stay identical.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Markdown } from "../src/components/markdown.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import type { Terminal } from "../src/terminal/types.ts";
import { Container, type Component } from "../src/tui.ts";
import { LayoutRecorder, recordLayout } from "../src/tui/layout-recorder.ts";
import { CURSOR_MARKER, renderFakeCursor } from "../src/tui/cursor.ts";
import type { OverlayHandle } from "../src/tui/overlay-types.ts";
import { withRenderIsolation } from "../src/tui/render-isolation.ts";
import { renderChanged, trackRenderChanges } from "../src/tui/render-signal.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

/** Tracked leaf: signals every change. */
class Signals implements Component {
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	set(lines: string[]): void {
		this.lines = lines;
		renderChanged(this);
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {
		renderChanged(this);
	}
}
trackRenderChanges(Signals.prototype);

/** Untracked leaf: the same array until changed, without a signal. */
class Rows implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Untracked leaf: a new array every frame. */
class Fresh implements Component {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

/** Tracked container that marks its rows, like the prompt-zone marks of a message. */
class Marked extends Container {
	private base: string[] | undefined;
	private marked: string[] = [];
	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines !== this.base) {
			this.base = lines;
			this.marked = lines.map((line) => `>${line}`);
		}
		return this.marked;
	}
}
trackRenderChanges(Marked.prototype);

/** Tracked container that sometimes draws without its children, like a hidden tool row or a renderer's own shell. */
class Shell extends Container {
	hidden = false;
	readonly own = new Rows(["own shell"]);
	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		renderChanged(this);
	}
	override render(width: number): string[] {
		return this.hidden ? this.own.render() : super.render(width);
	}
}
trackRenderChanges(Shell.prototype);

/** Tracked leaf that throws while `fail` is set; it starts failing only with a signal and may recover silently. */
class Boom implements Component {
	fail = false;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	setFail(): void {
		this.fail = true;
		renderChanged(this);
	}
	render(): string[] {
		if (this.fail) throw new Error("boom");
		return [this.text];
	}
	invalidate(): void {
		renderChanged(this);
	}
}
trackRenderChanges(Boom.prototype);

type Kind = "text" | "spacer" | "signals" | "rows" | "fresh" | "markdown" | "boom" | "container" | "marked" | "shell";
type Kind2 = Kind | "box" | "region";

/** One component in both trees, and the model of its children when it has any. */
interface Pair {
	kind: Kind2;
	a: Component;
	b: Component;
	kids?: Pair[];
}

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

const ids = new WeakMap<Component, number>();
/** Opt the reference tree out: an own `render` property is never tracked, so its parents render it every frame. */
function untrack<T extends Component>(component: T): T {
	(component as { render: Component["render"] }).render = Object.getPrototypeOf(component).render;
	return component;
}

class World {
	readonly next: () => number;
	readonly all: Pair[] = [];
	readonly root: Pair;
	private serial = 0;

	constructor(seed: number) {
		this.next = random(seed);
		this.root = this.pair("container", new Container(), new Container());
		this.root.kids = [];
		for (let index = 0; index < 12; index++) this.add(this.root, this.make(0));
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.next() * items.length)];
	}

	pair(kind: Kind2, a: Component, b: Component): Pair {
		const id = ++this.serial;
		ids.set(a, id);
		ids.set(b, id);
		const pair = { kind, a, b: untrack(b) };
		this.all.push(pair);
		return pair;
	}

	rows(): string[] {
		const count = Math.floor(this.next() * 4);
		const tag = this.serial;
		return Array.from({ length: count }, (_, row) => {
			const roll = this.next();
			// Some rows carry the editor's cursor marker or a fake cursor, which the main screen resolves.
			if (roll < 0.05) return `r${tag}.${row} edit${CURSOR_MARKER}${renderFakeCursor("x")} end`;
			if (roll < 0.08) return `r${tag}.${row} ${renderFakeCursor(" ")}`;
			return `r${tag}.${row} ${Math.floor(roll * 100)}`;
		});
	}

	make(depth: number): Pair {
		const roll = this.next();
		const words = () => `w${this.serial} ${"x".repeat(Math.floor(this.next() * 70))}`;
		if (depth < 3 && roll < 0.22) {
			const kind = this.pick(["container", "container", "marked", "shell"] as const);
			const create = () => (kind === "marked" ? new Marked() : kind === "shell" ? new Shell() : new Container());
			const pair = this.pair(kind, create(), create());
			pair.kids = [];
			for (let index = Math.floor(this.next() * 4); index > 0; index--) this.add(pair, this.make(depth + 1));
			return pair;
		}
		if (depth < 3 && roll < 0.3) {
			const pair = this.pair("box", new Box(1, 0, (s) => `[${s}]`), new Box(1, 0, (s) => `[${s}]`));
			pair.kids = [];
			for (let index = 1 + Math.floor(this.next() * 2); index > 0; index--) this.add(pair, this.make(depth + 1));
			return pair;
		}
		if (depth < 3 && roll < 0.36) {
			const child = this.make(depth + 1);
			const pair = this.pair(
				"region",
				new MouseRegion(child.a, () => undefined),
				new MouseRegion(child.b, () => undefined),
			);
			pair.kids = [child];
			return pair;
		}
		const kind = this.pick(["text", "text", "spacer", "signals", "rows", "fresh", "markdown", "boom"] as const);
		const text = words();
		const lines = this.rows();
		const both = (create: () => Component) => this.pair(kind, create(), create());
		if (kind === "text") return both(() => new Text(text, 1, 0));
		if (kind === "spacer") return both(() => new Spacer(1));
		if (kind === "signals") return both(() => new Signals(lines));
		if (kind === "rows") return both(() => new Rows(lines));
		if (kind === "fresh") return both(() => new Fresh(text));
		if (kind === "markdown") return both(() => new Markdown(`# ${text}\n\n- a\n- b`, 1, 0, defaultMarkdownTheme));
		return both(() => new Boom(text));
	}

	add(parent: Pair, child: Pair, at = parent.kids?.length ?? 0): void {
		parent.kids?.splice(at, 0, child);
		if (parent.kind === "box") {
			// Box has no insert: rebuild its children in order.
			for (const side of ["a", "b"] as const) {
				const box = parent[side] as Box;
				box.clear();
				for (const kid of parent.kids ?? []) box.addChild(kid[side]);
			}
			return;
		}
		for (const side of ["a", "b"] as const) {
			const container = parent[side] as Container;
			if (at === (parent.kids?.length ?? 1) - 1) container.addChild(child[side]);
			else container.children.splice(at, 0, child[side]);
		}
	}

	/** One random edit, applied to both trees. */
	step(): void {
		const roll = this.next();
		const of = (...kinds: Kind2[]) => this.all.filter((pair) => kinds.includes(pair.kind));
		const parents = of("container", "marked", "shell", "box").filter((pair) => pair.kids !== undefined);
		if (roll < 0.14) {
			const pair = this.pick(of("text"));
			const text = `edit ${this.serial++} ${"y".repeat(Math.floor(this.next() * 60))}`;
			if (pair) for (const side of [pair.a, pair.b]) (side as Text).setText(text);
		} else if (roll < 0.2) {
			const pair = this.pick(of("spacer"));
			const lines = Math.floor(this.next() * 3);
			if (pair) for (const side of [pair.a, pair.b]) (side as Spacer).setLines(lines);
		} else if (roll < 0.28) {
			const pair = this.pick(of("signals"));
			const lines = this.rows();
			if (pair) for (const side of [pair.a, pair.b]) (side as Signals).set(lines);
		} else if (roll < 0.34) {
			const pair = this.pick(of("rows"));
			const lines = this.rows();
			if (pair) for (const side of [pair.a, pair.b]) (side as Rows).lines = lines;
		} else if (roll < 0.38) {
			const pair = this.pick(of("fresh"));
			const text = `fresh ${this.serial++}`;
			if (pair) for (const side of [pair.a, pair.b]) (side as Fresh).text = text;
		} else if (roll < 0.41) {
			const pair = this.pick(of("markdown"));
			const text = `## md ${this.serial++}\n\n${"z ".repeat(Math.floor(this.next() * 40))}`;
			if (pair) for (const side of [pair.a, pair.b]) (side as Markdown).setText(text);
		} else if (roll < 0.44) {
			const pair = this.pick(of("boom"));
			const fail = this.next() < 0.5;
			if (pair)
				for (const side of [pair.a, pair.b] as Boom[]) {
					if (fail) side.setFail();
					else side.fail = false;
				}
		} else if (roll < 0.47) {
			const pair = this.pick(of("shell"));
			const hidden = this.next() < 0.5;
			const own = this.rows();
			// The shell's own rows are untracked: they change silently, and only a frame drawn without them is quiet.
			const silent = this.next() < 0.5;
			if (pair)
				for (const side of [pair.a, pair.b] as Shell[]) {
					side.own.lines = own;
					if (!silent) side.setHidden(hidden);
				}
		} else if (roll < 0.6) {
			const parent = this.pick(parents);
			if (parent) this.add(parent, this.make(2), Math.floor(this.next() * ((parent.kids?.length ?? 0) + 1)));
		} else if (roll < 0.7) {
			const parent = this.pick(parents.filter((pair) => (pair.kids?.length ?? 0) > 0));
			if (!parent?.kids) return;
			const at = Math.floor(this.next() * parent.kids.length);
			const [gone] = parent.kids.splice(at, 1);
			const direct = this.next() < 0.5 && parent.kind !== "box";
			for (const side of ["a", "b"] as const) {
				const owner = parent[side] as Container | Box;
				if (direct) (owner as Container).children.splice(at, 1);
				else owner.removeChild(gone[side]);
			}
			// Half of the removed subtrees come back elsewhere later.
			if (this.next() < 0.5) {
				const target = this.pick(parents.filter((pair) => pair !== gone && !contains(gone, pair)));
				if (target) this.add(target, gone, Math.floor(this.next() * ((target.kids?.length ?? 0) + 1)));
			}
		} else if (roll < 0.73) {
			const parent = this.pick(parents.filter((pair) => pair.kind !== "box" && (pair.kids?.length ?? 0) > 0));
			if (!parent?.kids) return;
			const at = Math.floor(this.next() * parent.kids.length);
			const fresh = this.make(2);
			parent.kids[at] = fresh;
			// An index assignment through the array, as some dialogs swap a child.
			for (const side of ["a", "b"] as const) (parent[side] as Container).children[at] = fresh[side];
		} else if (roll < 0.75) {
			const parent = this.pick(parents.filter((pair) => pair.kind !== "box" && pair !== this.root));
			if (!parent?.kids) return;
			parent.kids.reverse();
			for (const side of ["a", "b"] as const)
				(parent[side] as Container).children = (parent.kids ?? []).map((kid) => kid[side]);
		} else if (roll < 0.77) {
			const parent = this.pick(parents.filter((pair) => pair !== this.root));
			if (!parent?.kids) return;
			parent.kids.length = 0;
			for (const side of ["a", "b"] as const) (parent[side] as Container | Box).clear();
		} else if (roll < 0.8) {
			const pair = this.pick(of("box"));
			const mark = this.pick(["[", "<", "{"]);
			if (pair) for (const side of [pair.a, pair.b] as Box[]) side.setBgFn((s) => `${mark}${s}`);
		} else if (roll < 0.83) {
			const pair = this.next() < 0.2 ? this.root : this.pick(this.all);
			pair.a.invalidate();
			pair.b.invalidate();
		} else if (roll < 0.86) {
			const pair = this.pick(of("container"));
			if (pair) for (const side of [pair.a, pair.b] as Container[]) side.releaseRenderCache();
		} else if (roll < 0.92) {
			this.relink(this.pick(parents.filter((pair) => (pair.kids?.length ?? 0) > 0)));
		}
	}

	/**
	 * A structure edit that unlinks children, a change to one of them while it is unlinked or just linked again, and no
	 * render in between: remove and add it again at its old place, set the same list, or clear and add every child back.
	 */
	relink(parent: Pair | undefined): void {
		if (!parent?.kids) return;
		const kids = parent.kids;
		const at = Math.floor(this.next() * kids.length);
		const kid = kids[at];
		const mode = this.pick(["readd", "setter", "clear"] as const);
		if (mode === "readd") {
			kids.splice(at, 1);
			for (const side of ["a", "b"] as const) (parent[side] as Container | Box).removeChild(kid[side]);
			this.touch(kid);
			this.add(parent, kid, at);
			return;
		}
		for (const side of ["a", "b"] as const) {
			const owner = parent[side] as Container | Box;
			if (mode === "setter") owner.children = kids.map((entry) => entry[side]);
			else {
				owner.clear();
				if (side === "a") this.touch(kid);
				for (const entry of kids) owner.addChild(entry[side]);
			}
		}
		if (mode === "setter") this.touch(kid);
	}

	/** Change a leaf in `tree` that signals its change, in both trees. */
	touch(tree: Pair): void {
		const leaves: Pair[] = [];
		const walk = (pair: Pair) => {
			if (pair.kind === "text" || pair.kind === "signals") leaves.push(pair);
			for (const kid of pair.kids ?? []) walk(kid);
		};
		walk(tree);
		const leaf = this.pick(leaves);
		if (!leaf) return;
		const text = `touched ${this.serial++}`;
		for (const side of [leaf.a, leaf.b]) {
			if (leaf.kind === "text") (side as Text).setText(text);
			else (side as Signals).set([text]);
		}
	}
}

function contains(tree: Pair, target: Pair): boolean {
	return tree === target || (tree.kids ?? []).some((kid) => contains(kid, target));
}

const layoutOf = (recorder: LayoutRecorder) => ({
	leaves: recorder.leaves.map((leaf) => [ids.get(leaf.component), leaf.start, leaf.length]),
	starts: [...recorder.starts].map(([component, start]) => [ids.get(component), start]),
});

describe("render change signals", () => {
	for (const seed of [1, 2, 3, 4, 5, 6]) {
		it(`skipping quiet children paints what a full walk paints (seed ${seed})`, () => {
			const world = new World(seed);
			let width = 40;
			for (let step = 0; step < 500; step++) {
				world.step();
				if (world.next() < 0.08) width = world.pick([24, 40, 57]);
				// Sometimes subtrees are drawn on their own, outside the root's frame, between edits: a parent then sees a
				// child's rows a few frames later than the child made them.
				if (world.next() < 0.1) {
					for (let burst = 0; burst < 3; burst++) {
						const pair = world.pick(world.all.filter((entry) => entry.kids));
						const other = world.next() < 0.7 ? width : world.pick([24, 40, 57]);
						withRenderIsolation(
							() => {},
							() => assert.deepEqual(pair.a.render(other), pair.b.render(other), `subtree at step ${step}`),
						);
						world.step();
					}
				}
				const record = world.next() < 0.6;
				const paint = (component: Component) =>
					withRenderIsolation(
						() => {},
						() => {
							const recorder = new LayoutRecorder();
							const lines = record ? recordLayout(recorder, () => component.render(width)) : component.render(width);
							return { lines: lines.slice(), layout: record ? layoutOf(recorder) : undefined };
						},
					);
				const fast = paint(world.root.a);
				const full = paint(world.root.b);
				assert.deepEqual(fast.lines, full.lines, `rows at step ${step}`);
				assert.deepEqual(fast.layout, full.layout, `layout at step ${step}`);
			}
		});
	}

	it("a parent that missed some of a child's frames takes all of the child's rows again", () => {
		const header = new Text("header", 0, 0);
		const first = new Text("a0", 0, 0);
		const second = new Text("b0", 0, 0);
		const inner = new Container();
		inner.addChild(first);
		inner.addChild(second);
		const root = new Container();
		root.addChild(header);
		root.addChild(inner);
		const rows = () => root.render(20).map((line) => line.trim());
		assert.deepEqual(rows(), ["header", "a0", "b0"]);
		// The inner container renders twice on its own: its last frame shares a row with the one before, not with the
		// one its parent saw.
		first.setText("a1");
		inner.render(20);
		second.setText("b1");
		inner.render(20);
		assert.deepEqual(rows(), ["header", "a1", "b1"]);
	});

	it("a child unlinked by a structure edit and changed before the next render shows its new rows", () => {
		const rows = (component: Component) => component.render(20).map((line) => line.trim());
		for (const make of [() => new Container(), () => new Box(0, 0)]) {
			const root = new Container();
			const owner = make();
			root.addChild(owner);
			const a = new Text("alpha", 0, 0);
			const b = new Text("beta", 0, 0);
			owner.addChild(a);
			owner.addChild(b);
			assert.deepEqual(rows(root), ["alpha", "beta"]);
			// The setter with the same children, then a change to a kept child.
			owner.children = [a, b];
			b.setText("beta 2");
			assert.deepEqual(rows(root), ["alpha", "beta 2"]);
			// Removed, changed while unlinked, added again at its old place.
			owner.removeChild(b);
			b.setText("beta 3");
			owner.addChild(b);
			assert.deepEqual(rows(root), ["alpha", "beta 3"]);
			// Cleared, changed, every child added back.
			owner.clear();
			a.setText("alpha 4");
			owner.addChild(a);
			owner.addChild(b);
			assert.deepEqual(rows(root), ["alpha 4", "beta 3"]);
		}
	});

	it("a main-screen TUI writes the same bytes with and without skipping", () => {
		class Recording implements Terminal {
			readonly chunks: string[] = [];
			columns = 50;
			rows = 12;
			start(): void {}
			stop(): void {}
			async drainInput(): Promise<void> {}
			write(data: string): void {
				this.chunks.push(data);
			}
			get kittyProtocolActive(): boolean {
				return false;
			}
			moveBy(): void {}
			hideCursor(): void {}
			showCursor(): void {}
			clearLine(): void {}
			clearFromCursor(): void {}
			clearScreen(): void {}
			setTitle(): void {}
			setProgress(): void {}
			setProgramStatus(): void {}
		}
		for (const seed of [11, 12, 13]) {
			const world = new World(seed);
			const terminals = [new Recording(), new Recording()];
			const tuis = terminals.map((terminal) => new TuiMainScreen(terminal));
			tuis[0].addChild(world.root.a);
			tuis[1].addChild(world.root.b);
			// The reference renders its root into a plain array: no row frames and no shared-row hints downstream.
			const reference = tuis[1];
			reference.render = (width: number) => Container.prototype.render.call(reference, width);
			for (const tui of tuis) tui.start();
			let overlays: OverlayHandle[] | undefined;
			for (let step = 0; step < 300; step++) {
				world.step();
				// Overlays and the hardware cursor setting switch how rows are finished.
				const roll = world.next();
				if (roll < 0.05 && !overlays) {
					const text = `overlay ${step}`;
					overlays = tuis.map((tui) => tui.showOverlay(new Text(text, 1, 0), { anchor: "center", width: 20 }));
				} else if (roll < 0.1 && overlays) {
					for (const handle of overlays) handle.hide();
					overlays = undefined;
				} else if (roll < 0.12) {
					const show = world.next() < 0.5;
					for (const tui of tuis) tui.setShowHardwareCursor(show);
				}
				if (world.next() < 0.04) {
					const columns = world.pick([40, 50, 63]);
					for (const terminal of terminals) terminal.columns = columns;
				}
				for (const tui of tuis) tui.renderNow();
				assert.deepEqual(terminals[0].chunks, terminals[1].chunks, `seed ${seed} step ${step}`);
				assert.deepEqual(
					world.all.map((pair) => tuis[0].isAboveViewport(pair.a)),
					world.all.map((pair) => tuis[1].isAboveViewport(pair.b)),
					`seed ${seed} step ${step}: rows above the viewport`,
				);
			}
			for (const tui of tuis) tui.stop();
		}
	});
});
