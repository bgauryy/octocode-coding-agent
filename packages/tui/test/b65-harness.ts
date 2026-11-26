import { Markdown } from "../src/components/markdown.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getScrollViewBox } from "../src/layout.ts";
import type { LayoutFrame } from "../src/layout/types.ts";
import { Container } from "../src/tui/container.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { ImageRowsMemo, renderAltScreenOutput } from "../src/tui-alt-screen/frame.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** One frame: where the time went, and which layout path it took. */
export interface FrameSample {
	readonly step: string;
	readonly path: "virtual" | "exact";
	/** Application update: the input handler or the content change that asked for the frame. */
	readonly updateMs: number;
	/** The whole `doRender`: layout, Markdown, compositing, diff, output call. */
	readonly renderMs: number;
	/** Inside `renderMs`: Markdown rendering (cache misses only). */
	readonly markdownMs: number;
	/** Inside `renderMs`: the `terminal.write` call (the output queue). */
	readonly writeMs: number;
	/** Diff generation: the frame planner and buffer build, timed on its own for the same screens. */
	readonly diffMs: number;
	/** Update plus render: input to the frame being handed to the terminal. */
	readonly totalMs: number;
}

/**
 * Milliseconds of this process's CPU time. Frame costs are measured in CPU time, not wall time: the render is one
 * synchronous call, so the two agree on an idle machine, while other processes' load stretches only the wall clock.
 */
function cpuNowMs(): number {
	const { user, system } = process.cpuUsage();
	return (user + system) / 1000;
}

class TimedMarkdown extends Markdown {
	static ms = 0;
	override render(width: number): string[] {
		const start = cpuNowMs();
		try {
			return super.render(width);
		} finally {
			TimedMarkdown.ms += cpuNowMs() - start;
		}
	}
}

class TimedTerminal extends VirtualTerminal {
	writeMs = 0;
	override write(data: string): void {
		const start = cpuNowMs();
		super.write(data);
		this.writeMs += cpuNowMs() - start;
	}
}

const PARAGRAPHS = [
	"I read **`packages/tui/src/layout/virtual-scroll.ts`** and traced the gate: a frame is virtual until every row is measured, then exact.",
	"The change is small. It touches three files and one test; nothing else imports the helper, so the blast radius is the `render` path only.",
	"Short answer: yes. The cost is `O(rows)` once, then constant per frame, see [the notes](https://example.com/notes) for the numbers.",
];
const LIST =
	"- first check: *typecheck* clean\n- second check: `vitest` 81 passed\n- third check: lint, with a [link](https://example.com)";
const CODE =
	"```ts\nexport function settle(rows: number): number {\n\tlet measured = 0;\n\twhile (measured < rows) measured += 48;\n\treturn measured;\n}\n```";
const TABLE = "| rows | cold | steady |\n| --- | --- | --- |\n| 1k | 20 ms | 0.001 ms |\n| 10k | 144 ms | 0 ms |";

/** Assistant-style Markdown: paragraphs, lists, code blocks and tables, varying by index; `salt` keeps token caches apart. */
export function markdownRow(index: number, salt = 0): string {
	const parts = [`### Step ${index} (${salt})`, PARAGRAPHS[index % PARAGRAPHS.length]];
	if (index % 2 === 0) parts.push(LIST);
	if (index % 3 === 0) parts.push(CODE);
	if (index % 7 === 0) parts.push(TABLE);
	parts.push(PARAGRAPHS[(index + 1) % PARAGRAPHS.length]);
	return parts.join("\n\n");
}

export interface HarnessOptions {
	readonly rows: number;
	readonly virtualize: boolean;
	readonly markdown: boolean;
	readonly width?: number;
	readonly height?: number;
	readonly salt?: number;
}

interface Internals {
	doRender(): void;
	currentLayout: LayoutFrame | undefined;
	/** What the terminal shows after the last frame, and the diff's memos. */
	painter: { screen: string[]; width: number; height: number; trimmedRows: never };
	images: { protocol: never; uploaded: never };
	search: { activeSearch?: unknown };
}

export function createHarness(options: HarnessOptions) {
	const width = options.width ?? 100;
	const height = options.height ?? 30;
	const terminal = new TimedTerminal(width, height);
	const tui = new TuiAltScreen(terminal);
	const document = new Container();
	const rowAt = (index: number) =>
		options.markdown
			? new TimedMarkdown(markdownRow(index, options.salt ?? 0), 1, 0, defaultMarkdownTheme)
			: new Text(`row ${index} ${"lorem ipsum dolor sit amet ".repeat(1 + (index % 7))}`, 1, 0);
	for (let index = 0; index < options.rows; index++) document.addChild(rowAt(index));
	const transcript = new ScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
		// A transient scrollbar that fades mid-settle would make the virtual and exact screens differ by timing alone.
		scrollbarHideDelayMs: 600_000,
		virtualize: options.virtualize,
	});
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: new Text("> ", 0, 0), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
	// A selection copy flashes a timed notice (the clipboard limit, for a long selection): not part of the layout.
	tui.setCopyOnSelect(false);
	tui.start();
	const internals = tui as unknown as Internals;
	const frames: FrameSample[] = [];
	let step = "";
	let pendingUpdateMs = 0;

	const frame = (name = step): FrameSample => {
		step = name;
		const previous = {
			screen: internals.painter.screen,
			width: internals.painter.width,
			height: internals.painter.height,
		};
		TimedMarkdown.ms = 0;
		terminal.writeMs = 0;
		const start = cpuNowMs();
		internals.doRender();
		const renderMs = cpuNowMs() - start;
		const box = internals.currentLayout && getScrollViewBox(internals.currentLayout, transcript);
		const screen = internals.painter.screen;
		const diffStart = cpuNowMs();
		renderAltScreenOutput({
			screen,
			previousScreen: previous.screen,
			previousScreenWidth: previous.width,
			previousScreenHeight: previous.height,
			width: internals.painter.width,
			height: internals.painter.height,
			imageProtocol: internals.images.protocol,
			uploadedKittyImages: internals.images.uploaded,
			cursorPos: null,
			showHardwareCursor: false,
			trimmedRows: internals.painter.trimmedRows,
			imageRowsMemo: new ImageRowsMemo(),
		});
		const diffMs = cpuNowMs() - diffStart;
		const sample: FrameSample = {
			step,
			path: box?.materialize ? "virtual" : "exact",
			updateMs: pendingUpdateMs,
			renderMs,
			markdownMs: TimedMarkdown.ms,
			writeMs: terminal.writeMs,
			diffMs,
			totalMs: pendingUpdateMs + renderMs,
		};
		pendingUpdateMs = 0;
		frames.push(sample);
		return sample;
	};

	return {
		terminal,
		tui,
		document,
		transcript,
		frames,
		width,
		height,
		/** The screen as last painted. */
		screen: (): readonly string[] => internals.painter.screen.map(normalizeRow),
		searchOpen: () => internals.search.activeSearch !== undefined,
		/** Run `change` (timed as the application update), then paint one frame. */
		update(name: string, change: () => void): FrameSample {
			const start = cpuNowMs();
			change();
			pendingUpdateMs = cpuNowMs() - start;
			return frame(name);
		},
		/** Send terminal input (timed as the application update), then paint one frame. */
		input(name: string, data: string): FrameSample {
			return this.update(name, () => terminal.sendInput(data));
		},
		frame,
		/** Frames until the layout is exact for two in a row. */
		settle(name: string, max = 5000): FrameSample[] {
			const first = frames.length;
			let exactRun = 0;
			for (let count = 0; count < max && exactRun < 2; count++) {
				exactRun = frame(name).path === "exact" ? exactRun + 1 : 0;
			}
			return frames.slice(first);
		},
		/** Add a row at the end and return it, so a caller can grow its text like a streamed reply. */
		appendRow(index: number): { setText(text: string): void } {
			const row = rowAt(index);
			document.addChild(row);
			return row;
		},
		stop: () => tui.stop(),
	};
}

/** Hyperlink ids count per renderer instance; they do not change what is shown. */
const normalizeRow = (row: string) => row.replace(/id=oc[0-9-]+;/g, "id=;");

/** The first differing row of two screens, or undefined when equal. */
export function firstScreenDifference(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): string | undefined {
	if (!a || !b) return "missing screen";
	for (let row = 0; row < Math.max(a.length, b.length); row++) {
		if (a[row] !== b[row]) return `row ${row}: ${JSON.stringify(a[row])} vs ${JSON.stringify(b[row])}`.slice(0, 600);
	}
	return undefined;
}

export type Harness = ReturnType<typeof createHarness>;

export function percentiles(values: readonly number[]): { n: number; p50: number; p95: number; max: number } {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}
