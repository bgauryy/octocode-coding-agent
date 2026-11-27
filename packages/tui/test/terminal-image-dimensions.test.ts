import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGifDimensions, getPngDimensions, getWebpDimensions } from "../src/terminal-image/dimensions.ts";

describe("image header dimensions", () => {
	it("reads fixed headers from large base64 images", () => {
		const tail = Buffer.alloc(1024 * 1024);
		const png = Buffer.alloc(24);
		png.set([0x89, 0x50, 0x4e, 0x47]);
		png.writeUInt32BE(640, 16);
		png.writeUInt32BE(480, 20);
		const gif = Buffer.alloc(10);
		gif.write("GIF89a");
		gif.writeUInt16LE(320, 6);
		gif.writeUInt16LE(240, 8);
		const webp = Buffer.alloc(30);
		webp.write("RIFF", 0);
		webp.write("WEBP", 8);
		webp.write("VP8X", 12);
		webp[24] = 31;
		webp[27] = 15;
		for (const [header, dimensions, read] of [
			[png, { widthPx: 640, heightPx: 480 }, getPngDimensions],
			[gif, { widthPx: 320, heightPx: 240 }, getGifDimensions],
			[webp, { widthPx: 32, heightPx: 16 }, getWebpDimensions],
		] as const) {
			const data = Buffer.concat([header, tail]).toString("base64");
			assert.deepStrictEqual(read(data), dimensions);
			assert.deepStrictEqual(read(`${data.slice(0, 8)}\n${data.slice(8)}`), dimensions);
			assert.strictEqual(read(Buffer.alloc(8).toString("base64")), null);
		}
	});
});
