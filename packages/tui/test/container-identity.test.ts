import assert from "node:assert";
import { describe, it } from "node:test";
import { Container, Text } from "../src/index.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Counter implements Component {
	private lines = ["x"];
	set text(value: string) {
		this.lines = [value];
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Returns a new array every call, like a component with no cache. */
class Fresh implements Component {
	text = "one";
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	bytes = 0;
	override write(data: string): void {
		this.bytes += data.length;
		super.write(data);
	}
}

describe("Container identity", () => {
	it("returns the same array while every child array is unchanged", () => {
		const c = new Container();
		const a = new Text("a", 0, 0);
		const b = new Text("b", 0, 0);
		c.addChild(a);
		c.addChild(b);
		const first = c.render(40);
		assert.strictEqual(c.render(40), first);
		const outer = new Container();
		outer.addChild(c);
		const o = outer.render(40);
		assert.strictEqual(outer.render(40), o);
	});

	it("builds a new array on a width change, a child change, add or remove", () => {
		const c = new Container();
		const a = new Text("a", 0, 0);
		c.addChild(a);
		const first = c.render(40);
		assert.notStrictEqual(c.render(30), first);
		const second = c.render(30);
		a.setText("changed");
		const third = c.render(30);
		assert.notStrictEqual(third, second);
		assert.ok(third[0]?.startsWith("changed"));
		const extra = new Text("z", 0, 0);
		c.addChild(extra);
		assert.strictEqual(c.render(30).length, 2);
		c.removeChild(extra);
		assert.strictEqual(c.render(30).length, 1);
	});

	it("shows updates of a child that returns a new array every frame, at any nesting depth", () => {
		const inner = new Container();
		const leaf = new Fresh();
		inner.addChild(leaf);
		const outer = new Container();
		outer.addChild(inner);
		assert.deepStrictEqual(outer.render(20), ["one"]);
		leaf.text = "two";
		assert.deepStrictEqual(outer.render(20), ["two"]);
	});

	it("propagates invalidate to children", () => {
		let invalidated = 0;
		const child: Component = { render: () => ["k"], invalidate: () => void invalidated++ };
		const inner = new Container();
		inner.addChild(child);
		const outer = new Container();
		outer.addChild(inner);
		outer.render(10);
		outer.invalidate();
		assert.strictEqual(invalidated, 1);
		assert.deepStrictEqual(outer.render(10), ["k"]);
	});

	it("writes zero bytes for an identical frame and still paints an update", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const chat = new Container();
		const leaf = new Counter();
		chat.addChild(leaf);
		tui.addChild(chat);
		tui.start();
		tui.renderNow();
		const painted = chat.render(40);
		terminal.bytes = 0;
		tui.renderNow();
		assert.strictEqual(terminal.bytes, 0);
		assert.strictEqual(chat.render(40), painted);
		leaf.text = "updated";
		chat.invalidate();
		tui.renderNow();
		assert.ok(terminal.bytes > 0);
		tui.stop();
	});
});
