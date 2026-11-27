import { stripTerminalSequences } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

const copied = vi.hoisted(() => [] as string[]);
vi.mock("../../src/utils/clipboard.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	copyToClipboard: async (text: string) => {
		copied.push(text);
	},
}));

/** Fullscreen transcript flows (scroll, wheel, search, drag-select copy) on an xterm grid in the real host. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";
const SEARCH = "\x1b[102;6u"; // ctrl+shift+f, kitty encoding
const wheelUp = (x = 10, y = 10) => `\x1b[<64;${x};${y}M`;
const wheelDown = (x = 10, y = 10) => `\x1b[<65;${x};${y}M`;

/** Click the reply's fold hint so only the reply (not startup details) expands. */
async function expandFoldedReply(): Promise<void> {
	await t!.until(async () => (await t!.text()).includes("lines hidden"), "folded reply hint");
	const folded = await t!.grid();
	const hint = folded.findIndex((line) => line.includes("lines hidden"));
	const col = folded[hint].indexOf("lines hidden") + 1;
	t!.press(`\x1b[<0;${col};${hint + 1}M`);
	t!.press(`\x1b[<0;${col};${hint + 1}m`);
	await t!.until(async () => !(await t!.text()).includes("lines hidden"), "expanded long reply");
}

/** One long assistant reply: `row-00 marker` … `row-79 marker`, a blank line apart. */
async function longTranscript(): Promise<void> {
	const reply = Array.from({ length: 80 }, (_, i) => `row-${String(i).padStart(2, "0")} marker`).join("\n\n");
	t!.script(reply);
	await t!.type("go");
	t!.press(KEY.enter);
	await t!.until(async () => (await t!.text()).includes("row-79"), "long reply at the bottom");
}
/** The screen rows, trimmed, without the scrollbar column: its track and thumb come and go as the view scrolls. */
const rows = async () => (await t!.grid()).map((line) => line.replace(/[│┃█]\s*$/, "").trim());
/** The transcript view's scroll position: the first line of its document on screen. */
const scrollTop = () => t!.host.transcriptScrollView!.scrollTop;
/**
 * Whether the terminal shows the transcript at its current scroll position: `marker` on the screen row its line in the
 * document puts it. A frame drawn before the view moved, or while its layout still settles, puts it elsewhere.
 */
const shownAt = async (marker: string) => {
	const line = t!.host.documentContainer
		.render(120)
		.findIndex((row) => stripTerminalSequences(row).trim().startsWith(marker));
	return line >= 0 && (await rows()).findIndex((row) => row.startsWith(marker)) === line - scrollTop();
};
const has = (all: string[], text: string) => all.some((row) => row.startsWith(text));
const jump = "Jump to latest message";

describe("fullscreen transcript", () => {
	it("copies literal code and opens keyboard reference actions from message source", async () => {
		copied.length = 0;
		t = await startUi();
		t.script("Read [the guide](https://example.com/guide).\n\n```ts\nconst text = '**literal**';\n```");
		await t.type("show references");
		t.press(KEY.enter);
		await t.until(
			() => !t!.host.session.isStreaming && Boolean(t!.host.session.getLastAssistantText()),
			"answer settled",
		);
		await t.submit("/copy code");
		await t.until(() => copied.length === 1, "semantic code copy");
		expect(copied[0]).toBe("const text = '**literal**';");
		const selecting = t.host.defaultEditor.onSubmit?.("/links");
		await t.until(async () => (await t!.text()).includes("References"), "reference picker");
		await t.type("guide");
		t.press(KEY.enter);
		await t.until(async () => (await t!.text()).includes("Copy destination"), "reference actions");
		await t.type("Copy destination");
		t.press(KEY.enter);
		await t.until(() => copied.length === 2, "copied destination");
		expect(copied[1]).toBe("https://example.com/guide");
		await t.until(async () => !(await t!.text()).includes("Copy destination"), "returned to the prompt");
		await selecting;
	});

	it("PageUp, Ctrl+Home, wheel and Ctrl+End move the viewport; a jump hint shows while scrolled up", async () => {
		t = await startUi();
		await longTranscript();
		await expandFoldedReply();
		expect(has(await rows(), "row-79")).toBe(true);
		expect((await t.text()).includes(jump)).toBe(false);

		await t.type("unsent draft");
		const composer = (await t.grid()).findIndex((row) => row.includes("unsent draft"));
		expect(composer).toBeGreaterThan(0);
		const before = scrollTop();
		t.press(wheelUp(10, composer + 1));
		await t.until(
			async () => scrollTop() < before && (await t!.text()).includes(jump),
			"wheel over the focused editor scrolled the transcript",
		);
		const scrolledUp = scrollTop();
		t.press(wheelDown(10, composer + 1));
		await t.until(() => scrollTop() > scrolledUp, "wheel down over the editor scrolled back toward latest");
		expect(t.host.editor.getText()).toBe("unsent draft");

		t.press(KEY.pageUp);
		await t.until(async () => !has(await rows(), "row-79"), "viewport left the bottom");
		expect(await t.text()).toContain(jump);

		t.press(CTRL_HOME);
		await t.until(async () => scrollTop() === 0 && (await shownAt("row-00")), "top of the transcript");

		t.press(wheelDown());
		await t.until(async () => scrollTop() > 0 && (await shownAt("row-00")), "wheel scrolled down");
		// A wheel event closer than a notch (100 ms) to the one before moves fewer lines. The first one has been handled, so
		// one sent at least a notch later moves as far back, whatever the load: the view returns to where it started.
		await wait(150);
		t.press(wheelUp());
		await t.until(async () => scrollTop() === 0 && (await shownAt("row-00")), "wheel scrolled back up");

		t.press(CTRL_END);
		await t.until(async () => has(await rows(), "row-79"), "back at the bottom");
		expect((await t.text()).includes(jump)).toBe(false);
	});

	it("shows a folded long reply in the terminal and expands its hidden rows on click", async () => {
		t = await startUi();
		await longTranscript();
		await t.until(async () => (await t!.text()).includes("lines hidden"), "the settled reply's fold hint");
		const folded = await t.grid();
		const hint = folded.findIndex((line) => line.includes("lines hidden"));
		expect(has(await rows(), "row-79")).toBe(true);
		const col = folded[hint].indexOf("lines hidden") + 1;
		t.press(`\x1b[<0;${col};${hint + 1}M`);
		t.press(`\x1b[<0;${col};${hint + 1}m`);
		await t.until(async () => !(await t!.text()).includes("lines hidden"), "opened the reply");
		t.press(KEY.pageUp);
		await t.until(async () => (await rows()).some((row) => /^row-[4-6]\d marker/.test(row)), "previously hidden rows");
	});

	it("search jumps to an off-screen match and Escape closes the search box", async () => {
		t = await startUi();
		await longTranscript();
		await expandFoldedReply();
		expect(has(await rows(), "row-07")).toBe(false);
		t.press(SEARCH);
		await wait(200);
		await t.type("row-07");
		await t.until(async () => has(await rows(), "row-07"), "match scrolled into view");
		expect(await t.text()).toMatch(/Shift\+Enter/);
		t.press(KEY.esc);
		await t.until(async () => !/Shift\+Enter/.test(await t!.text()), "search box closed");
		expect(has(await rows(), "row-07")).toBe(true);
	});

	it("dragging across transcript rows selects them and copies once on release", async () => {
		copied.length = 0;
		t = await startUi();
		await longTranscript();
		const grid = await t.grid();
		const first = grid.findIndex((row) => row.trim().startsWith("row-"));
		const startRow = first + 1;
		const endRow = first + 3;
		const col = grid[first].indexOf("row-") + 1;
		t.press(`\x1b[<0;${col};${startRow}M`);
		t.press(`\x1b[<32;${col + 4};${endRow}M`);
		t.press(`\x1b[<0;${col + 4};${endRow}m`);
		await t.until(() => copied.length === 1, "one clipboard write on release");
		// The press row whole to the release column, a blank line apart: `row-00 marker`, a break, then `row-0`.
		expect(copied[0]).toMatch(/^row-\d+ marker\n\nrow-\d$/);
		expect(copied).toHaveLength(1);
	});
});
