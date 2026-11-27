/** A frame whose only change is the scroll position shows what a fresh screen shows at that position. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import { Text } from "../src/components/text.ts";
import { Container } from "../src/tui/container.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function build() {
	const terminal = new VirtualTerminal(60, 12);
	const tui = new TuiAltScreen(terminal);
	const transcript = new Container();
	for (let item = 0; item < 300; item++)
		transcript.addChild(new Text(`\x1b[32mitem-${item}\x1b[0m ${"lorem ".repeat(item % 7)}`));
	const scroll = new ScrollView(transcript, { follow: "end", primary: true, virtualize: true });
	tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
	tui.start();
	return { terminal, tui };
}

describe("scroll-only frames", () => {
	it("match a fresh paint at the same position, in screen rows and in the terminal", async () => {
		const wheel = build();
		const fresh = build();
		try {
			await wheel.terminal.waitForRender();
			wheel.tui.scrollToTop();
			await wheel.terminal.waitForRender();
			for (const step of [3, 3, 5, -2, 40, -90, 1]) {
				wheel.tui.scrollBy(step);
				await wheel.terminal.waitForRender();
				const top = wheel.tui.viewportTop;
				fresh.tui.scrollToTop();
				fresh.tui.scrollBy(top);
				await fresh.terminal.waitForRender();
				assert.equal(fresh.tui.viewportTop, top);
				assert.deepEqual(wheel.tui.getScreenLines(), fresh.tui.getScreenLines(), `rows at ${top}`);
				assert.deepEqual(
					await wheel.terminal.flushAndGetViewport(),
					await fresh.terminal.flushAndGetViewport(),
					`terminal at ${top}`,
				);
			}
		} finally {
			wheel.tui.stop();
			fresh.tui.stop();
		}
	});
});
