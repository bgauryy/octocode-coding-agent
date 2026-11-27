import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import {
	allocateImageId,
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	encodeKitty,
	isImageLine,
	renderImage,
	TMUX_PASSTHROUGH_LIMIT,
} from "../src/terminal-image.ts";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../src/terminal-image/capabilities.ts";
import { ROWCOLUMN_DIACRITICS } from "../src/terminal-image/kitty-diacritics.ts";
import { getKittyImageMetadata, getKittyImagePlacement } from "../src/terminal-image/kitty-metadata.ts";
import { KITTY_PLACEHOLDER, kittyPlaceholderRow } from "../src/terminal-image/kitty-placeholder.ts";
import { ansiCodeLength } from "../src/utils/ansi-codes.ts";
import { visibleWidth } from "../src/utils/width.ts";

const TMUX_KITTY = { images: "kitty", trueColor: true, hyperlinks: true, kittyPlaceholders: true } as const;
const PLAIN_KITTY = { images: "kitty", trueColor: true, hyperlinks: true } as const;
const PNG = "A".repeat(10000);
const mark = (index: number): string => String.fromCodePoint(ROWCOLUMN_DIACRITICS[index]);

beforeEach(() => setCellDimensions({ widthPx: 10, heightPx: 20 }));
afterEach(() => resetCapabilitiesCache());

describe("passthrough-wrapped Kitty sequences", () => {
	it("sends every chunk of a transmission in one passthrough envelope", () => {
		// tmux may put another pane's output between envelopes; interleaved chunked uploads lose both images.
		setCapabilities(TMUX_KITTY);
		const out = encodeKitty(PNG, { columns: 4, rows: 2, imageId: 7, virtual: true });
		const esc = (s: string): string => s.replaceAll("\x1b", "\x1b\x1b");
		assert.equal(
			out,
			"\x1bPtmux;" +
				esc(`\x1b_Ga=T,f=100,q=2,U=1,c=4,r=2,i=7,m=1;${PNG.slice(0, 4096)}\x1b\\`) +
				esc(`\x1b_Gm=1;${PNG.slice(4096, 8192)}\x1b\\`) +
				esc(`\x1b_Gm=0;${PNG.slice(8192)}\x1b\\`) +
				"\x1b\\",
		);
	});

	it("splits an upload larger than tmux's input buffer at chunk boundaries", () => {
		setCapabilities(TMUX_KITTY);
		const data = "B".repeat(TMUX_PASSTHROUGH_LIMIT * 2 + 5000);
		const out = encodeKitty(data, { imageId: 8, virtual: true });
		const envelopes = out.split("\x1bPtmux;").slice(1);
		assert.equal(envelopes.length, 3);
		for (const envelope of envelopes) {
			assert.ok(envelope.length + "\x1bPtmux;".length <= TMUX_PASSTHROUGH_LIMIT + 16);
			assert.ok(envelope.startsWith("\x1b\x1b_G"));
			assert.ok(envelope.endsWith("\x1b\x1b\\\x1b\\"));
		}
		assert.ok(envelopes[0].startsWith("\x1b\x1b_Ga=T,f=100,q=2,U=1,i=8,m=1;"));
		assert.ok(envelopes[2].includes("\x1b\x1b_Gm=0;"));
		const payload = [...out.matchAll(/_G(?:[^;]*);([A-Z]*)/g)].map((m) => m[1]).join("");
		assert.equal(payload, data);
	});

	it("wraps single-chunk, delete and placement-delete commands", () => {
		setCapabilities(TMUX_KITTY);
		assert.equal(deleteKittyImage(42), "\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=42,q=2\x1b\x1b\\\x1b\\");
		assert.equal(deleteAllKittyImages(), "\x1bPtmux;\x1b\x1b_Ga=d,d=A,q=2\x1b\x1b\\\x1b\\");
		assert.equal(deleteAllKittyPlacements(), "\x1bPtmux;\x1b\x1b_Ga=d,d=a,q=2\x1b\x1b\\\x1b\\");
		assert.equal(encodeKitty("AAAA", { imageId: 1 }), "\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,i=1;AAAA\x1b\x1b\\\x1b\\");
	});

	it("leaves output byte-identical outside tmux", () => {
		setCapabilities(PLAIN_KITTY);
		assert.equal(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		assert.equal(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
		assert.equal(deleteAllKittyPlacements(), "\x1b_Ga=d,d=a,q=2\x1b\\");
		assert.equal(
			encodeKitty(PNG, { columns: 4, rows: 2, imageId: 7, moveCursor: false }),
			`\x1b_Ga=T,f=100,q=2,C=1,c=4,r=2,i=7,m=1;${PNG.slice(0, 4096)}\x1b\\` +
				`\x1b_Gm=1;${PNG.slice(4096, 8192)}\x1b\\\x1b_Gm=0;${PNG.slice(8192)}\x1b\\`,
		);
		const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, imageId: 9 });
		assert.equal(result?.lines, undefined);
		assert.ok(result?.sequence.startsWith("\x1b_Ga=T,f=100,q=2,c=2,r=1,i=9;"));
	});
});

describe("placeholder rows", () => {
	it("encodes the image id in the foreground colour and names row and column", () => {
		const row = kittyPlaceholderRow(0x010203, 1, 2);
		assert.equal(
			row,
			`\x1b[38;2;1;2;3m${KITTY_PLACEHOLDER}${mark(1)}${mark(0)}${KITTY_PLACEHOLDER}${mark(1)}${mark(1)}\x1b[39m`,
		);
	});

	it("carries the high id byte in a third diacritic", () => {
		const row = kittyPlaceholderRow(0x05000009, 0, 1);
		assert.equal(row, `\x1b[38;2;0;0;9m${KITTY_PLACEHOLDER}${mark(0)}${mark(0)}${mark(5)}\x1b[39m`);
	});

	it("measures one cell per placeholder", () => {
		assert.equal(visibleWidth(kittyPlaceholderRow(0x05000009, 3, 6)), 6);
		assert.equal(visibleWidth(kittyPlaceholderRow(77, 0, 12)), 12);
	});

	it("measures a passthrough envelope as zero width", () => {
		setCapabilities(TMUX_KITTY);
		const wrapped = encodeKitty(PNG, { imageId: 7, virtual: true });
		assert.equal(ansiCodeLength(wrapped, 0), wrapped.length);
		assert.equal(visibleWidth(`${wrapped}abc`), 3);
	});

	it("renders one text line per row with the transmit on the first", () => {
		setCapabilities(TMUX_KITTY);
		const result = renderImage("AAAA", { widthPx: 40, heightPx: 40 }, { maxWidthCells: 4, imageId: 0x0a0b0c });
		assert.ok(result?.lines);
		assert.equal(result.lines.length, result.rows);
		assert.ok(result.lines[0].startsWith("\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,U=1,"));
		assert.ok(result.lines[0].includes("i=658188"));
		assert.ok(result.lines[1].startsWith("\x1b[38;2;10;11;12m"));
		for (const line of result.lines) {
			assert.equal(isImageLine(line), true);
			assert.equal(visibleWidth(line.slice(line.indexOf("\x1b[38;"))), result.columns);
		}
	});

	it("returns the Image component's rows without cursor moves", () => {
		setCapabilities(TMUX_KITTY);
		const image = new Image(
			"AAAA",
			"image/png",
			{ fallbackColor: (s) => s },
			{ maxWidthCells: 3 },
			{ widthPx: 30, heightPx: 60 },
		);
		const lines = image.render(40);
		assert.ok(lines.length > 1);
		assert.ok(lines.every((line) => !line.includes("\x1b[") || line.includes(KITTY_PLACEHOLDER)));
		assert.ok(lines.every(isImageLine));
	});

	it("does not treat placeholder-looking text as an image outside tmux", () => {
		setCapabilities(PLAIN_KITTY);
		assert.equal(isImageLine(kittyPlaceholderRow(5, 0, 2)), false);
	});

	it("keeps placement and crop logic away from wrapped sequences", () => {
		setCapabilities(TMUX_KITTY);
		const result = renderImage("AAAA", { widthPx: 40, heightPx: 40 }, { maxWidthCells: 4, imageId: 31 });
		assert.ok(result?.lines);
		assert.equal(getKittyImageMetadata(result.lines[0]), undefined);
		assert.equal(getKittyImagePlacement(result.lines[0]), undefined);
	});

	it("allocates ids that fit the foreground colour only in placeholder mode", () => {
		setCapabilities(TMUX_KITTY);
		for (let i = 0; i < 200; i++) assert.ok(allocateImageId() <= 0xffffff);
		setCapabilities(PLAIN_KITTY);
		assert.ok(Array.from({ length: 200 }, allocateImageId).some((id) => id > 0xffffff));
	});
});
