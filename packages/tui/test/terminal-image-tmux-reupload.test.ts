import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import { encodeKitty, renderImage, TMUX_PASSTHROUGH_LIMIT } from "../src/terminal-image.ts";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../src/terminal-image/capabilities.ts";
import { kittyPassthroughUploads, TmuxImageReupload } from "../src/terminal-image/tmux-reupload.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const TMUX_KITTY = { images: "kitty", trueColor: true, hyperlinks: true, kittyPlaceholders: true } as const;
const PLAIN_KITTY = { images: "kitty", trueColor: true, hyperlinks: true } as const;
const FOCUS_IN = "\x1b[I";
const PNG = "A".repeat(10000);
const theme = { fallbackColor: (text: string) => text };

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(() => setCellDimensions({ widthPx: 10, heightPx: 20 }));
afterEach(() => resetCapabilitiesCache());

describe("kittyPassthroughUploads", () => {
	it("returns every Kitty envelope of the rendered lines, including a split upload, and nothing else", () => {
		setCapabilities(TMUX_KITTY);
		const small = renderImage(PNG, { widthPx: 40, heightPx: 40 }, { maxWidthCells: 4, imageId: 5 })!;
		const large = encodeKitty("B".repeat(TMUX_PASSTHROUGH_LIMIT + 5000), { imageId: 6, virtual: true });
		assert.equal(large.split("\x1bPtmux;").length - 1, 2);
		const other = "\x1bPtmux;\x1b\x1b]777;notify;a;b\x07\x1b\\";
		const lines = ["plain", ...small.lines!, `  ${large}row`, other];
		assert.equal(kittyPassthroughUploads(lines), small.sequence + large);
		assert.equal(kittyPassthroughUploads(["plain", other]), "");
	});

	it("skips an unterminated envelope", () => {
		assert.equal(kittyPassthroughUploads(["\x1bPtmux;\x1b\x1b_Ga=T;AAAA"]), "");
	});
});

describe("TmuxImageReupload", () => {
	it("sends the uploads when tmux lists a new client or cannot answer, not on a pane switch", async () => {
		let clients: readonly string[] | undefined = ["100 1"];
		let queries = 0;
		const reupload = new TmuxImageReupload(async () => {
			queries++;
			return clients;
		});
		const writes: string[] = [];
		const lines = () => ["\x1bPtmux;\x1b\x1b_Ga=T,i=1;AAAA\x1b\x1b\\\x1b\\\u{10eeee}"];
		const focus = () => reupload.focusIn(lines, (data) => writes.push(data));

		await focus(); // first check: clients not known yet
		assert.equal(writes.length, 1);
		assert.equal(writes[0], "\x1bPtmux;\x1b\x1b_Ga=T,i=1;AAAA\x1b\x1b\\\x1b\\");
		await focus(); // pane switch: same client
		assert.equal(writes.length, 1);
		clients = ["100 1", "200 2"]; // second client attached
		await focus();
		assert.equal(writes.length, 2);
		clients = ["200 2"]; // first client detached
		await focus();
		assert.equal(writes.length, 2);
		clients = undefined; // tmux did not answer
		await focus();
		assert.equal(writes.length, 3);
		assert.equal(queries, 5);
	});

	it("runs one check for focus-ins that arrive while one is pending, and writes nothing without uploads", async () => {
		let queries = 0;
		const reupload = new TmuxImageReupload(async () => {
			queries++;
			await new Promise((resolve) => setTimeout(resolve, 20));
			return ["1 1"];
		});
		const writes: string[] = [];
		await Promise.all([
			reupload.focusIn(
				() => ["text"],
				(data) => writes.push(data),
			),
			reupload.focusIn(
				() => ["text"],
				(data) => writes.push(data),
			),
		]);
		assert.equal(queries, 1);
		assert.deepEqual(writes, []);
	});
});

describe("focus-in in the main-screen TUI", () => {
	let saved: { TMUX?: string; PATH?: string };
	let emptyBin: string;
	beforeEach(() => {
		saved = { TMUX: process.env.TMUX, PATH: process.env.PATH };
		// No tmux on PATH: the client query fails, which counts as a possibly new client.
		emptyBin = mkdtempSync(join(tmpdir(), "no-tmux-"));
		process.env.PATH = emptyBin;
		process.env.TMUX = "/tmp/tmux-test/default,1,0";
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(emptyBin, { recursive: true, force: true });
	});

	async function focusInAfterRender(capabilities: typeof TMUX_KITTY | typeof PLAIN_KITTY) {
		setCapabilities(capabilities);
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Image(PNG, "image/png", theme, { maxWidthCells: 4, imageId: 77 }, { widthPx: 40, heightPx: 40 }));
		tui.start();
		await terminal.waitForRender();
		const before = terminal.written.length;
		terminal.sendInput(FOCUS_IN);
		return { terminal, tui, before };
	}

	it("writes the image upload again under tmux placeholders", async () => {
		const { terminal, tui, before } = await focusInAfterRender(TMUX_KITTY);
		try {
			await until(() => terminal.written.length > before);
			const again = terminal.written.slice(before);
			assert.equal(again.length, 1);
			assert.match(again[0], /^\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,U=1,c=\d+,r=\d+,i=77,/);
			assert.ok(again[0].endsWith("\x1b\\"));
			assert.ok(terminal.written.slice(0, before).join("").includes(again[0]), "the same upload as the first render");
		} finally {
			tui.stop();
		}
	});

	it("writes nothing for a focus-in outside placeholder mode", async () => {
		const { terminal, tui, before } = await focusInAfterRender(PLAIN_KITTY);
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.deepEqual(terminal.written.slice(before), []);
		} finally {
			tui.stop();
		}
	});
});
