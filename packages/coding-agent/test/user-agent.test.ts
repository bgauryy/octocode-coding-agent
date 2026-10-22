import { describe, expect, it } from "vitest";
import { getOctocodeUserAgent } from "../src/utils/user-agent.ts";

describe("getOctocodeUserAgent", () => {
	it("formats the Octocode user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getOctocodeUserAgent("1.2.3");

		expect(userAgent).toBe(`octocode/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^octocode\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
