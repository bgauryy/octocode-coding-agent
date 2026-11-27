import { describe, expect, it } from "vitest";
import { OCTOCODE_FAVICON_DATA_URI } from "../src/favicon.generated.ts";
import { renderBacklogHtml } from "../src/index.ts";

const snapshot = { repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] } as never;

describe("favicon", () => {
	it("is a small 64x64 PNG data URI", () => {
		const match = /^data:image\/png;base64,(.+)$/.exec(OCTOCODE_FAVICON_DATA_URI);
		const bytes = Buffer.from(match![1], "base64");
		expect(bytes.subarray(1, 4).toString()).toBe("PNG");
		expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 64]);
		expect(bytes.length).toBeLessThan(8 * 1024);
	});

	it.each([false, true])("is linked and allowed by the content security policy (live=%s)", (live) => {
		const html = renderBacklogHtml(snapshot, live);
		expect(html).toContain(`<link rel="icon" type="image/png" href="${OCTOCODE_FAVICON_DATA_URI}">`);
		expect(html).toMatch(/Content-Security-Policy" content="[^"]*default-src 'none'[^"]*img-src data:/);
		expect(html).not.toMatch(/img-src[^;"]*(https?:|\*)/);
	});
});
