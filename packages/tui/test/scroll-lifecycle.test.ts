import assert from "node:assert/strict";
import { it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("collects stopped renderer graphs without waiting for long scrollbar deadlines", () => {
	const child = fileURLToPath(new URL("./fixtures/renderer-retention-child.ts", import.meta.url));
	const result = spawnSync(process.execPath, ["--expose-gc", child], { encoding: "utf8", timeout: 15000 });
	assert.equal(result.status, 0, result.stderr || String(result.error));
});

class ObservedTui extends TuiAltScreen {
	requests = 0;
	override requestRender(force = false): void {
		this.requests++;
		super.requestRender(force);
	}
}

it("stops scrollbar timers and releases callbacks on stop, then reattaches on restart", async () => {
	const terminal = new VirtualTerminal(40, 6);
	const tui = new ObservedTui(terminal);
	const scroll = new ScrollView(new Text("line\n".repeat(100)), {
		scrollbar: "auto",
		follow: "end",
		scrollbarHideDelayMs: 20,
	});
	tui.setLayoutRoot(scroll);
	tui.start();
	tui.renderNow();
	scroll.scrollBy(-2);
	assert.equal(scroll.isScrollbarVisible, true);
	tui.stop({ preserveScreen: true });
	const requested = tui.requests;
	assert.equal(scroll.isScrollbarVisible, false);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(tui.requests, requested);
	tui.start();
	try {
		tui.renderNow();
		scroll.scrollBy(-2);
		assert.equal(scroll.isScrollbarVisible, true);
	} finally {
		tui.stop({ preserveScreen: true });
		await terminal.flush();
	}
});

it("detaches the replaced layout so an old scrollbar cannot request frames", async () => {
	const tui = new ObservedTui(new VirtualTerminal(40, 6));
	const old = new ScrollView(new Text("line\n".repeat(100)), { scrollbar: "auto", follow: "end" });
	tui.setLayoutRoot(old);
	tui.start();
	try {
		tui.renderNow();
		old.scrollBy(-2);
		tui.setLayoutRoot(new Text("replacement"));
		const requested = tui.requests;
		old.scrollBy(-2);
		assert.equal(old.isScrollbarVisible, false);
		assert.equal(tui.requests, requested);
	} finally {
		old.detach();
		tui.stop({ preserveScreen: true });
	}
});
