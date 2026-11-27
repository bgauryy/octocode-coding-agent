/**
 * A jump to the top or the end of the transcript (ctrl+home, ctrl+end) paints the rows at the new `viewportTop` in the
 * first frame it asks for, even right after a width change, while rows above the view still hold the old width's
 * estimates. The position changes at the key and the screen at that frame, so a reader compares the two after it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Component } from "../src/tui/component.ts";
import { Container } from "../src/tui/container.ts";
import { trackRenderChanges } from "../src/tui/render-signal.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";
const ROWS = 8;

/** 40 characters cut to the width; slow to render once per width, so measuring the rest takes many slices. */
class Entry implements Component {
	private cache?: { width: number; lines: string[] };
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		for (const start = performance.now(); performance.now() - start < 0.5;);
		const lines: string[] = [];
		for (let at = 0; at < this.text.length; at += width) lines.push(this.text.slice(at, at + width));
		this.cache = { width, lines };
		return lines;
	}
	invalidate(): void {}
}
trackRenderChanges(Entry.prototype);

/** Records, for each frame written, the scroll position it was painted at. */
class FrameTerminal extends VirtualTerminal {
	readonly paintedAt: number[] = [];
	position: () => number = () => -1;
	override write(data: string): void {
		this.paintedAt.push(this.position());
		super.write(data);
	}
}

describe("jump to the top or the end of the transcript", () => {
	it("paints the rows at the new position in its first frame, before and after a width change", async () => {
		const terminal = new FrameTerminal(30, ROWS);
		const tui = new TuiAltScreen(terminal);
		const transcript = new Container();
		for (let item = 0; item < 400; item++)
			transcript.addChild(new Entry(`item-${String(item).padStart(3, "0")} `.padEnd(40, ".")));
		const scroll = new ScrollView(transcript, { follow: "end", primary: true, virtualize: true });
		tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
		terminal.position = () => tui.viewportTop;
		/** The rows a terminal of this width shows: xterm keeps the cells past a narrower width in its buffer. */
		const screen = async () =>
			(await terminal.flushAndGetViewport()).map((row) => row.slice(0, terminal.columns).trimEnd());
		const content = () => transcript.render(terminal.columns).map((row) => stripTerminalSequences(row).trimEnd());

		const jump = async (key: string, label: string) => {
			const from = terminal.paintedAt.length;
			terminal.sendInput(key);
			await terminal.waitForRender();
			const frames = terminal.paintedAt.slice(from);
			assert.ok(frames.length > 0, `${label}: a frame was painted`);
			if (key === CTRL_HOME) {
				assert.deepEqual(
					frames,
					frames.map(() => 0),
					`${label}: every frame at the top`,
				);
				assert.deepEqual(await screen(), content().slice(0, ROWS), `${label}: the first rows`);
			} else {
				assert.equal(tui.isFollowingOutput, true, `${label}: following the end`);
				assert.deepEqual(await screen(), content().slice(-ROWS), `${label}: the last rows`);
			}
		};

		tui.start();
		try {
			await terminal.waitForRender();
			assert.ok(tui.viewportTop > 0);
			await jump(CTRL_HOME, "top");
			await jump(CTRL_END, "end");
			for (const columns of [50, 30]) {
				terminal.resize(columns, ROWS);
				await terminal.waitForRender();
				// The frame at the new width laid out only the rows in view: the rest still hold estimates.
				assert.equal(scroll.isContentSettled, false, `${columns} columns: rows above still estimated`);
				await jump(CTRL_HOME, `top at ${columns} columns`);
				await jump(CTRL_END, `end at ${columns} columns`);
			}
		} finally {
			tui.stop();
		}
	});
});
