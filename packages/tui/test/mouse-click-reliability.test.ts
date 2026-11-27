import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import { type Component, Container, type TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** A row that records the mouse events it is offered and handles the types in `handled`. */
class Row implements Component {
	readonly events: string[] = [];

	private readonly label: string;
	private readonly handled: readonly string[];

	constructor(label: string, handled: readonly string[]) {
		this.label = label;
		this.handled = handled;
	}

	invalidate(): void {}

	render(): string[] {
		return [this.label];
	}

	handleMouse(event: TuiMouseEvent) {
		this.events.push(`${event.type}:${event.clickCount ?? ""}`);
		return this.handled.includes(event.type) ? { handled: true } : undefined;
	}
}

const sgr = (button: number, x: number, y: number, release = false) =>
	`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;

function fill(scroll: ScrollView): VStack {
	return new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }]);
}

async function started(rows: number, setup: (tui: TuiAltScreen) => void, wheelScrollLines: "auto" | number = 1) {
	const terminal = new VirtualTerminal(20, rows);
	const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines });
	setup(tui);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui };
}

interface SelectionInternals {
	selection: { selectionPressActive: boolean };
	scrollbar: { scrollbarDrag: unknown };
}

describe("a click survives pointer jitter and moving content", () => {
	it("clicks a press-handling component when the pointer jitters off and back to the press cell", async () => {
		const row = new Row("target", ["press"]);
		const { terminal, tui } = await started(2, (t) => t.addChild(row));
		try {
			terminal.sendInput(sgr(0, 1, 0));
			terminal.sendInput(sgr(32, 2, 0));
			terminal.sendInput(sgr(32, 1, 0));
			terminal.sendInput(sgr(0, 1, 0, true));
			assert.ok(row.events.includes("click:1"), row.events.join(","));
		} finally {
			tui.stop();
		}
	});

	it("clicks a click-only component after sub-cell jitter inside the press cell", async () => {
		const row = new Row("target", ["click"]);
		const { terminal, tui } = await started(2, (t) => t.addChild(row));
		try {
			terminal.sendInput(sgr(0, 1, 0));
			terminal.sendInput(sgr(32, 1, 0));
			terminal.sendInput(sgr(32, 1, 0));
			terminal.sendInput(sgr(0, 1, 0, true));
			assert.ok(row.events.includes("click:1"), row.events.join(","));
		} finally {
			tui.stop();
		}
	});

	it("clicks the row under the press cell although the content scrolled before release", async () => {
		const rows = Array.from({ length: 30 }, (_, index) => new Row(`row ${index}`, ["click"]));
		const body = new Container();
		for (const row of rows) body.addChild(row);
		const scroll = new ScrollView(body, { primary: true });
		const { terminal, tui } = await started(5, (t) => t.setLayoutRoot(fill(scroll)));
		try {
			scroll.scrollToStart();
			terminal.sendInput(sgr(0, 1, 2));
			scroll.scrollBy(3);
			await terminal.waitForRender();
			terminal.sendInput(sgr(0, 1, 2, true));
			assert.ok(rows[2].events.includes("click:1"), `row 2: ${rows[2].events.join(",")}`);
			assert.ok(!rows[5].events.includes("click:1"), "the row now under the cell is not clicked");
			const selection = (tui as unknown as { selection: { getActiveSelectionText(): string | undefined } }).selection;
			assert.equal(selection.getActiveSelectionText(), undefined, "no selection from the scroll");
		} finally {
			tui.stop();
		}
	});

	it("ends a stranded text press when motion arrives with no button held", async () => {
		const { terminal, tui } = await started(2, (t) => t.addChild(new Row("plain text", [])));
		try {
			const internals = tui as unknown as SelectionInternals;
			terminal.sendInput(sgr(0, 1, 0));
			assert.equal(internals.selection.selectionPressActive, true);
			terminal.sendInput(sgr(35, 4, 0));
			assert.equal(internals.selection.selectionPressActive, false);
		} finally {
			tui.stop();
		}
	});

	it("ends a stranded scrollbar drag when motion arrives with no button held", async () => {
		const rows = new Container();
		for (let index = 0; index < 60; index++) rows.addChild(new Row(`r${index}`, []));
		const tall = new ScrollView(rows, { primary: true, scrollbar: "always" });
		const { terminal, tui } = await started(10, (t) => t.setLayoutRoot(fill(tall)));
		try {
			const internals = tui as unknown as SelectionInternals;
			terminal.sendInput(sgr(0, 19, 0));
			terminal.sendInput(sgr(32, 19, 3));
			assert.ok(internals.scrollbar.scrollbarDrag, "the thumb drag started");
			terminal.sendInput(sgr(35, 10, 3));
			assert.equal(internals.scrollbar.scrollbarDrag, undefined);
		} finally {
			tui.stop();
		}
	});
});

describe("wheel scrolling in the alternate screen", () => {
	it("extends a held selection on the wheel and releases over the original cell without clicking it", async () => {
		const rows = Array.from({ length: 30 }, (_, i) => new Row(`row ${i}`, ["click"]));
		const body = new Container();
		for (const row of rows) body.addChild(row);
		const scroll = new ScrollView(body, { primary: true });
		const { terminal, tui } = await started(6, (t) => t.setLayoutRoot(fill(scroll)));
		try {
			tui.setCopyOnSelect(false);
			scroll.scrollToStart();
			await terminal.waitForRender();
			terminal.sendInput(sgr(0, 0, 2));
			terminal.sendInput(sgr(65, 0, 2));
			const selection = (tui as unknown as { selection: { getActiveSelectionText(): string | undefined } }).selection;
			assert.equal(selection.getActiveSelectionText(), "row 2\nr");
			terminal.sendInput(sgr(0, 0, 2, true));
			assert.equal(selection.getActiveSelectionText(), "row 2\nr");
			assert.ok(!rows[2].events.includes("click:1"));
		} finally {
			tui.stop();
		}
	});

	it("moves the lines a burst asked for beyond one frame's cap over the following frames", async () => {
		const rows = Array.from({ length: 400 }, (_, index) => new Row(`row ${index}`, []));
		const body = new Container();
		for (const row of rows) body.addChild(row);
		const scroll = new ScrollView(body, { primary: true });
		const { terminal, tui } = await started(10, (t) => t.setLayoutRoot(fill(scroll)), "auto");
		try {
			scroll.scrollToStart();
			await terminal.waitForRender();
			for (let index = 0; index < 60; index++) terminal.sendInput(sgr(65, 1, 3));
			const first = scroll.scrollTop;
			assert.ok(first <= 24, `one frame moved ${first}`);
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.ok(scroll.scrollTop >= 60, `the burst of 60 events moved ${scroll.scrollTop} rows in all`);
		} finally {
			tui.stop();
		}
	});

	it("moves exactly the wheel's rows up from the last painted frame while following the end", async () => {
		const body = new Container();
		for (let index = 0; index < 50; index++) body.addChild(new Row(`row ${index}`, []));
		const scroll = new ScrollView(body, { follow: "end", primary: true });
		const { terminal, tui } = await started(10, (t) => t.setLayoutRoot(fill(scroll)));
		try {
			await terminal.waitForRender();
			const painted = scroll.scrollTop;
			for (let index = 0; index < 20; index++) body.addChild(new Row(`late ${index}`, []));
			scroll.scrollBy(-3);
			assert.equal(scroll.scrollTop, painted - 3);
			await terminal.waitForRender();
			assert.equal(scroll.scrollTop, painted - 3, "growth does not move a view that left the end");
		} finally {
			tui.stop();
		}
	});
});
