import { describe, expect, it, vi } from "vitest";

vi.mock("node:worker_threads", () => ({
	Worker: class {
		constructor() {
			throw new Error("worker unavailable");
		}
	},
}));

import { IN_PROCESS_RESIZE_LIMIT, imageResizeStats, resizeImage } from "../src/utils/image-resize.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

describe("image resize worker fallback", () => {
	it("resizes on the calling thread when no worker starts, and counts it", async () => {
		const before = imageResizeStats();
		const result = await resizeImage(TINY_PNG, "image/png");
		expect(result?.width).toBe(1);
		const after = imageResizeStats();
		expect(after.inProcess).toBe(before.inProcess + 1);
		expect(after.worker).toBe(before.worker);
		expect(after.lastWorkerError).toBe("worker unavailable");
		expect(after.inProcessMaxMs).toBeGreaterThanOrEqual(0);
	});

	it("omits an image too large to decode on the calling thread instead of blocking it", async () => {
		const before = imageResizeStats();
		const huge = Buffer.concat([TINY_PNG, Buffer.alloc(IN_PROCESS_RESIZE_LIMIT)]);
		expect(await resizeImage(huge, "image/png")).toBeNull();
		const after = imageResizeStats();
		expect(after.inProcessRefused).toBe(before.inProcessRefused + 1);
		expect(after.inProcess).toBe(before.inProcess);
	});
});
