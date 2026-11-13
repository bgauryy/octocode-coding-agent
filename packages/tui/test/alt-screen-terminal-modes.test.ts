import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { animationClock } from "../src/tokens/clock.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class WriteLog extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	count(sequence: string): number {
		return this.writes.filter((write) => write.includes(sequence)).length;
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `condition` holds; a loaded machine only makes this slower, never wrong. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (const start = Date.now(); !condition(); await wait(2)) {
		if (Date.now() - start > 2000) assert.fail(`timed out waiting for ${what}`);
	}
}
const BUTTON_MOTION = "\x1b[?1002h";
const ANY_MOTION_ON = "\x1b[?1003h";
const ANY_MOTION_OFF = "\x1b[?1003l";
const WHEEL_UP = "\x1b[<64;1;1M";

function transcript(terminal: WriteLog, hideDelayMs = 1000) {
	const tui = new TuiAltScreen(terminal);
	const scroll = new ScrollView(new Text(Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"), 0, 0), {
		follow: "end",
		primary: true,
		scrollbar: "auto",
		scrollbarHideDelayMs: hideDelayMs,
	});
	tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
	tui.start();
	return { tui, scroll };
}

const MULTIPLEXER_KEYS = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
let savedEnvironment: Map<string, string | undefined>;

describe("alternate-screen terminal modes", () => {
	beforeEach(() => {
		savedEnvironment = new Map(MULTIPLEXER_KEYS.map((key) => [key, process.env[key]]));
		for (const key of MULTIPLEXER_KEYS) delete process.env[key];
		process.env.TERM = "xterm-256color";
	});
	afterEach(() => {
		for (const [key, value] of savedEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("tracks bare pointer movement only while a scrollbar is on screen", async () => {
		const terminal = new WriteLog(40, 10);
		const { tui } = transcript(terminal, 40);
		await terminal.waitForRender();
		// Clicks, the wheel and drags need button-motion tracking only.
		assert.strictEqual(terminal.count(BUTTON_MOTION), 1);
		assert.strictEqual(terminal.count(ANY_MOTION_ON), 0, "an idle pointer reports nothing");
		terminal.sendInput(WHEEL_UP);
		// The scroll shows the scrollbar: hovering it highlights it, so movement is tracked while it shows.
		await until(() => terminal.count(ANY_MOTION_ON) === 1, "movement tracking with the scrollbar shown");
		await until(() => terminal.count(ANY_MOTION_OFF) === 1, "no movement tracking once the scrollbar hides");
		assert.strictEqual(terminal.count(ANY_MOTION_ON), 1);
		tui.stop();
	});

	it("never tracks bare pointer movement inside a multiplexer", async () => {
		process.env.TMUX = "/tmp/tmux/default,1,0";
		const terminal = new WriteLog(40, 10);
		const { tui } = transcript(terminal);
		await terminal.waitForRender();
		terminal.sendInput(WHEEL_UP);
		await wait(30);
		assert.strictEqual(terminal.count(ANY_MOTION_ON), 0);
		assert.ok(terminal.count(BUTTON_MOTION) > 0);
		tui.stop();
	});

	it("writes the modes again on focus-in, resize and SIGCONT, and stops listening once stopped", async () => {
		const listeners = process.listenerCount("SIGCONT");
		const terminal = new WriteLog(40, 10);
		const { tui } = transcript(terminal);
		await terminal.waitForRender();
		const modes = () => terminal.count(`\x1b[?7l\x1b[?1000h${BUTTON_MOTION}`);
		assert.strictEqual(modes(), 1);
		terminal.sendInput("\x1b[I");
		assert.strictEqual(modes(), 2, "focus-in");
		terminal.resize(50, 12);
		await until(() => modes() === 3, "the modes after a resize");
		process.emit("SIGCONT", "SIGCONT");
		assert.strictEqual(modes(), 4, "SIGCONT");
		tui.stop();
		assert.strictEqual(process.listenerCount("SIGCONT"), listeners);
		process.emit("SIGCONT", "SIGCONT");
		assert.strictEqual(modes(), 4);
	});

	it("keeps routing the wheel to the transcript while the next frame repaints the screen whole", async () => {
		const terminal = new WriteLog(40, 10);
		const { tui, scroll } = transcript(terminal);
		await terminal.waitForRender();
		const top = scroll.scrollTop;
		// A forced repaint (frame-drop recovery, a capability change) resets the screen state before its frame paints.
		tui.requestRender(true);
		terminal.sendInput(WHEEL_UP);
		assert.strictEqual(scroll.scrollTop, top - 1, "the wheel scrolled the transcript, not the implicit document");
		tui.stop();
	});

	it("holds decoration still while the wheel turns", async () => {
		const terminal = new WriteLog(40, 10);
		const { tui } = transcript(terminal);
		await terminal.waitForRender();
		terminal.sendInput(WHEEL_UP);
		const frozen = animationClock.decorationTime();
		await wait(30);
		assert.strictEqual(animationClock.decorationTime(), frozen);
		tui.stop();
	});
});
