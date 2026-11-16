import { describe, expect, it } from "vitest";
import { formatBytes } from "../src/utils/bytes.ts";

describe("formatBytes", () => {
	it("keeps each surface's wording", () => {
		expect([512, 1536, 5 * 1024 * 1024].map((n) => formatBytes(n))).toEqual(["512B", "1.5KB", "5.0MB"]);
		expect([312, 18 * 1024, 2.1 * 1024 * 1024].map((n) => formatBytes(n, "spaced"))).toEqual([
			"312 B",
			"18 KB",
			"2.1 MB",
		]);
		expect([312, 1536, 12.3 * 1024 ** 2, 4.2 * 1024 ** 3, 3 * 1024 ** 4].map((n) => formatBytes(n, "binary"))).toEqual([
			"312 B",
			"1.50 KiB",
			"12.3 MiB",
			"4.20 GiB",
			"3.00 TiB",
		]);
	});
});
