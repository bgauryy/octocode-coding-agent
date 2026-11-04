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

/** One long assistant reply: `row-00 marker` … `row-79 marker`, a blank line apart. */
async function longTranscript(): Promise<void> {
	const reply = Array.from({ length: 80 }, (_, i) => `row-${String(i).padStart(2, "0")} marker`).join("\n\n");
	t!.script(reply);
	await t!.type("go");
	t!.press(KEY.enter);
	await t!.until(async () => (await t!.text()).includes("row-79"), "long reply at the bottom");
}
const rows = async () => (await t!.grid()).map((line) => line.trim());
const has = (all: string[], text: string) => all.some((row) => row.startsWith(text));
const jump = "Jump to latest message";

describe("fullscreen transcript", () => {
	it("PageUp, Ctrl+Home, wheel and Ctrl+End move the viewport; a jump hint shows while scrolled up", async () => {
		t = await startUi();
		await longTranscript();
		expect(has(await rows(), "row-79")).toBe(true);
		expect((await t.text()).includes(jump)).toBe(false);

		t.press(KEY.pageUp);
		await t.until(async () => !has(await rows(), "row-79"), "viewport left the bottom");
		expect(await t.text()).toContain(jump);

		t.press(CTRL_HOME);
		await t.until(async () => has(await rows(), "row-00") || has(await rows(), "row-01"), "top of the transcript");
		const atTop = await rows();

		t.press(wheelDown());
		await t.until(
			async () =>
				!has(
					await rows(),
					atTop.find((r) => r.startsWith("row-"))!,
				),
			"wheel scrolled down",
		);
		t.press(wheelUp());
		await t.until(
			async () =>
				has(
					await rows(),
					atTop.find((r) => r.startsWith("row-"))!,
				),
			"wheel scrolled back up",
		);

		t.press(CTRL_END);
		await t.until(async () => has(await rows(), "row-79"), "back at the bottom");
		expect((await t.text()).includes(jump)).toBe(false);
	});

	it("search jumps to an off-screen match and Escape closes the search box", async () => {
		t = await startUi();
		await longTranscript();
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

	it("dragging across transcript rows copies the selected text to the clipboard", async () => {
		t = await startUi();
		await longTranscript();
		t.press(KEY.pageUp);
		await t.until(async () => !has(await rows(), "row-79"), "scrolled up");
		const grid = await t.grid();
		const first = grid.findIndex((row) => row.trim().startsWith("row-"));
		const startRow = first + 1; // 1-based
		const endRow = first + 3;
		const label = grid[first].trim().match(/^row-\d+ marker/)?.[0] ?? "";
		const next = grid[first + 2].trim().match(/^row-\d+/)?.[0] ?? "";
		const col = grid[first].indexOf("row-") + 1;
		t.press(`\x1b[<0;${col};${startRow}M`);
		t.press(`\x1b[<32;${col + 4};${endRow}M`);
		t.press(`\x1b[<0;${col + 4};${endRow}m`);
		await t.until(() => copied.length > 0, "clipboard write");
		expect(copied.at(-1)).toContain(label);
		expect(copied.at(-1)).toContain(next.slice(0, 5)); /* the drag ends 4 columns into the second row */
	});
});
