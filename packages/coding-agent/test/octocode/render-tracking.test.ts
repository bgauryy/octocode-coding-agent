/**
 * Octocode's tool-row components (`Lines`, `ReportView`, the reason row and the purpose block) declare their render
 * changes, so a transcript keeps their rows between frames. Differential test: two identical trees take the same random
 * edits; in one the components take part in signals, in the other each has its own `render` (never tracked), so every
 * frame renders it as before. Their rows must stay identical, and a quiet frame of the tracked tree renders none of them.
 */
import { Box, type Component, Container, type Header, Lines, MouseRegion, type Row } from "@octocodeai/octocode-tui";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ReportView } from "../../src/octocode/render/report.ts";
import { purposeBlock } from "../../src/octocode/ui/purpose-block.ts";
import { reasonRow } from "../../src/octocode/ui/reason-row.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";

// Colors on, so a theme change shows in the rows.
vi.stubEnv("NO_COLOR", "");
vi.stubEnv("TERM", "xterm-256color");
initTheme("dark");
afterAll(() => vi.unstubAllEnvs());

function random(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda".split(" ");

/** Opt the reference tree out: an own `render` property is never tracked. */
function untrack<T extends Component>(component: T): T {
	(component as { render: Component["render"] }).render = Object.getPrototypeOf(component).render;
	return component;
}

/** One tool row in both trees: the leaves a test edits, and the row containers. */
interface Pair {
	lines: [Lines, Lines];
	leaves: Array<[Component, Component]>;
	rows: [Container, Container];
}

class World {
	readonly next: () => number;
	readonly roots: [Container, Container] = [new Container(), new Container()];
	readonly pairs: Pair[] = [];
	dark = true;

	constructor(seed: number) {
		this.next = random(seed);
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.next() * items.length)];
	}

	text(words: number): string {
		return Array.from({ length: words }, () => this.pick(WORDS)).join(" ");
	}

	header(): Header {
		return {
			left: `${theme.fg("success", "✓")} ${theme.bold(this.pick(["Read", "Bash", "Agent"]))}(`,
			summary: theme.fg("muted", this.text(3)),
			right: `) · ${Math.floor(this.next() * 9)}s`,
		};
	}

	rowsOf(): Row[] {
		const count = Math.floor(this.next() * 6);
		return Array.from({ length: count }, (_, index) =>
			this.next() < 0.4
				? { text: this.text(12), wrap: true, indent: "     ", lead: index === 0 ? "  ⎿  " : "     " }
				: { text: theme.fg("toolOutput", this.text(5)), lead: "     " },
		);
	}

	/** Both twins of a leaf, made by the same factory; the reference one untracked. */
	twin<T extends Component>(make: () => T): [T, T] {
		return [make(), untrack(make())];
	}

	addRow(): void {
		const header = this.header();
		const rows = this.rowsOf();
		const lines = this.twin(() => new Lines().set(header, rows));
		const leaves: Array<[Component, Component]> = [lines];
		const reason = this.text(6);
		if (this.next() < 0.6) leaves.push(this.twin(() => reasonRow("bash", { reason })!));
		const report = `## ${this.text(2)}\n\n${this.text(30)}\n\n- ${this.text(4)}\n- ${this.text(4)}`;
		const expanded = this.next() < 0.5;
		if (this.next() < 0.4) leaves.push(this.twin(() => new ReportView(theme, report, expanded, "prompt", 1)));
		const purpose = { results: [{ mainGoal: this.text(4), reasoning: this.text(5) }] };
		if (this.next() < 0.4) leaves.push(this.twin(() => purposeBlock(purpose)!));
		const rows2 = [0, 1].map((side) => {
			const box = new Box(1, 0);
			for (const leaf of leaves) box.addChild(new MouseRegion(leaf[side], () => undefined));
			const row = new Container();
			row.addChild(box);
			return row;
		}) as [Container, Container];
		const at = Math.floor(this.next() * (this.pairs.length + 1));
		this.pairs.splice(at, 0, { lines, leaves, rows: rows2 });
		for (const side of [0, 1]) this.roots[side].children.splice(at, 0, rows2[side]);
	}

	step(): void {
		const roll = this.next();
		if (this.pairs.length === 0 || roll < 0.15) return this.addRow();
		const pair = this.pick(this.pairs);
		if (roll < 0.25) {
			const at = this.pairs.indexOf(pair);
			this.pairs.splice(at, 1);
			for (const side of [0, 1]) this.roots[side].removeChild(pair.rows[side]);
		} else if (roll < 0.7) {
			// A renderer pass: the same Lines takes a new header or new rows, or the same content again.
			const header = this.next() < 0.3 ? undefined : this.header();
			const rows = this.next() < 0.3 ? [] : this.rowsOf();
			for (const lines of pair.lines) lines.set(header, rows);
		} else if (roll < 0.85) {
			const leaf = this.pick(pair.leaves);
			for (const component of leaf) component.invalidate();
		} else if (roll < 0.88) {
			// A theme change: the host invalidates the whole tree, and rows that read the theme draw in the new colors.
			this.dark = !this.dark;
			initTheme(this.dark ? "dark" : "light");
			if (this.next() < 0.5) for (const root of this.roots) root.invalidate();
			// A component invalidated on its own (a renderer's `context.invalidate`) must reach the frame by its signal.
			else
				for (const each of this.pairs)
					for (const leaf of each.leaves) for (const component of leaf) component.invalidate();
		}
		// Otherwise a quiet frame.
	}
}

/** Count renders of the tracked components, whichever tree draws them. */
function countRenders(): { count: number; restore(): void } {
	const counter = {
		count: 0,
		restore: () => {
			for (const [prototype, render] of saved) prototype.render = render;
		},
	};
	const prototypes = [
		Lines.prototype,
		ReportView.prototype,
		Object.getPrototypeOf(reasonRow("bash", { reason: "check the build output" })!),
		Object.getPrototypeOf(purposeBlock({ results: [{ mainGoal: "g", reasoning: "r" }] })!),
	] as Array<{ render: Component["render"] }>;
	const saved = prototypes.map((prototype) => [prototype, prototype.render] as const);
	for (const [prototype, render] of saved)
		prototype.render = function (this: Component, width: number) {
			counter.count++;
			return render.call(this, width);
		};
	return counter;
}

describe("octocode tool rows take part in render signals", () => {
	for (const seed of [1, 2, 3, 4, 5, 6]) {
		it(`skipping quiet rows paints what rendering every row paints (seed ${seed})`, () => {
			initTheme("dark");
			const world = new World(seed);
			for (let index = 0; index < 6; index++) world.addRow();
			let width = 60;
			for (let step = 0; step < 400; step++) {
				world.step();
				if (world.next() < 0.05) width = 20 + Math.floor(world.next() * 80);
				const [tracked, reference] = world.roots.map((root) => root.render(width));
				expect(tracked, `seed ${seed} step ${step}`).toEqual(reference);
			}
		});
	}

	it("renders none of them in a frame where nothing changed, and only the one that signalled", () => {
		const counter = countRenders();
		try {
			const world = new World(7);
			for (let index = 0; index < 20; index++) world.addRow();
			const [tracked, reference] = world.roots;
			expect(tracked.render(80).join("\n")).toContain("\x1b[38;");
			reference.render(80);
			counter.count = 0;
			tracked.render(80);
			expect(counter.count).toBe(0);
			reference.render(80);
			expect(counter.count).toBeGreaterThanOrEqual(20);

			counter.count = 0;
			const lines = world.pairs[3].lines[0];
			lines.set({ left: "✓ Read(", summary: "changed", right: ")" }, [{ text: "new row" }]);
			const after = tracked.render(80);
			expect(counter.count).toBe(1);
			expect(after.some((line) => line.includes("changed"))).toBe(true);
		} finally {
			counter.restore();
		}
	});

	it("draws a component invalidated on its own in the new theme", () => {
		initTheme("dark");
		const make = () => [
			reasonRow("bash", { reason: "check the build output" })!,
			purposeBlock({ results: [{ mainGoal: "find the flake", reasoning: "it fails under load" }] })!,
			new ReportView(theme, "**report** body", false),
		];
		const tracked = make();
		const reference = make().map(untrack);
		const roots = [tracked, reference].map((leaves) => {
			const root = new Container();
			for (const leaf of leaves) {
				const box = new Box(1, 0);
				box.addChild(new MouseRegion(leaf, () => undefined));
				root.addChild(box);
			}
			return root;
		});
		expect(roots[0].render(60)).toEqual(roots[1].render(60));
		initTheme("light");
		for (const leaf of [...tracked, ...reference]) leaf.invalidate();
		const [after, expected] = roots.map((root) => root.render(60));
		expect(after).toEqual(expected);
		initTheme("dark");
	});
});
