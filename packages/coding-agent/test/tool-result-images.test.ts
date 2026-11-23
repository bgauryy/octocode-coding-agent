import { describe, expect, it } from "vitest";
import type { ToolResultContent } from "../src/utils/tool-result-images.ts";
import { normalizeToolResultImages } from "../src/utils/tool-result-images.ts";
import { createPng, createTinyBmp1x1Red24bpp } from "./image-fixtures.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function readPngDimensions(base64Data: string): { width: number; height: number } {
	const buffer = Buffer.from(base64Data, "base64");
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function imageBlock(bytes: Buffer, mimeType: string): ToolResultContent {
	return { type: "image", data: bytes.toString("base64"), mimeType };
}

describe("normalizeToolResultImages", () => {
	it("returns the original array when there are no image blocks", async () => {
		const content: ToolResultContent[] = [{ type: "text", text: "no images here" }];

		expect(await normalizeToolResultImages(content)).toBe(content);
	});

	it("returns the original array when images are already within limits", async () => {
		const content: ToolResultContent[] = [
			{ type: "text", text: "screenshot" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		];

		expect(await normalizeToolResultImages(content)).toBe(content);
	});

	it("resizes oversized images and reports the original dimensions", async () => {
		const content: ToolResultContent[] = [imageBlock(createPng(2400, 4800), "image/png")];

		const normalized = await normalizeToolResultImages(content);

		expect(normalized).not.toBe(content);
		expect(normalized).toHaveLength(2);
		const image = normalized[0];
		expect(image.type).toBe("image");
		if (image.type !== "image") return;
		const { width, height } = readPngDimensions(image.data);
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
		const note = normalized[1];
		expect(note.type).toBe("text");
		if (note.type !== "text") return;
		expect(note.text).toContain("original 2400x4800");
	});

	it("leaves oversized images alone when auto-resize is disabled", async () => {
		const content: ToolResultContent[] = [imageBlock(createPng(2400, 4800), "image/png")];

		const normalized = await normalizeToolResultImages(content, { autoResizeImages: false });

		expect(normalized).toBe(content);
	});

	it("converts unsupported image formats even when auto-resize is disabled", async () => {
		const content: ToolResultContent[] = [imageBlock(createTinyBmp1x1Red24bpp(), "image/bmp")];

		const normalized = await normalizeToolResultImages(content, { autoResizeImages: false });

		expect(normalized).not.toBe(content);
		expect(normalized[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(normalized[1]).toMatchObject({
			type: "text",
			text: "[Image converted from image/bmp to image/png.]",
		});
	});

	it("keeps undecodable images instead of dropping tool output", async () => {
		const content: ToolResultContent[] = [{ type: "image", data: "bm90LWFuLWltYWdl", mimeType: "image/png" }];

		expect(await normalizeToolResultImages(content)).toBe(content);
	});

	it("preserves surrounding text blocks and their order", async () => {
		const content: ToolResultContent[] = [
			{ type: "text", text: "before" },
			imageBlock(createPng(2400, 100), "image/png"),
			{ type: "text", text: "after" },
		];

		const normalized = await normalizeToolResultImages(content);

		expect(normalized.map((block) => block.type)).toEqual(["text", "image", "text", "text"]);
		expect(normalized[0]).toEqual({ type: "text", text: "before" });
		expect(normalized[3]).toEqual({ type: "text", text: "after" });
	});
});
