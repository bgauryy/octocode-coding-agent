import assert from "node:assert/strict";
import { Container } from "../../src/tui/container.ts";
import { Text } from "../../src/components/text.ts";
import { ScrollView } from "../../src/components/scroll-view.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

class SinkTerminal {
	columns = 80;
	rows = 12;
	kittyProtocolActive = false;
	start() {}
	stop() {}
	async drainInput() {}
	write() {}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
}

const refs: WeakRef<object>[] = [];
function cycle(): void {
	const terminal = new SinkTerminal();
	const tui = new TuiAltScreen(terminal);
	const chat = new Container();
	chat.addChild(new Text("rendered content\n".repeat(100)));
	const scroll = new ScrollView(chat, { follow: "end", scrollbar: "auto", scrollbarHideDelayMs: 60_000 });
	for (const object of [terminal, tui, chat, scroll]) refs.push(new WeakRef(object));
	tui.setLayoutRoot(scroll);
	tui.start();
	tui.renderNow();
	scroll.scrollBy(-2);
	tui.stop({ preserveScreen: true });
}
for (let i = 0; i < 20; i++) cycle();
for (let i = 0; i < 3; i++) {
	await new Promise<void>((resolve) => setImmediate(resolve));
	globalThis.gc!();
}
assert.equal(refs.filter((ref) => ref.deref()).length, 0, "stopped renderer graphs must be collectible before scrollbar deadlines");
