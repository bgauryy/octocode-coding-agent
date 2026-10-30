import { describe, expect, it } from "vitest";
import { errorCorrection, qrModules, qrText } from "../../src/octocode/remote/qr.ts";

describe("QR encoder", () => {
	it("computes the Reed-Solomon codewords of the specification's 1-M example", () => {
		// "HELLO WORLD" (alphanumeric) in a 1-M symbol: the data codewords and their ten error-correction codewords.
		const data = Uint8Array.from([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
		expect([...errorCorrection(data, 10)]).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
	});

	it("builds a valid-looking symbol: right size, finder patterns, timing, dark module, and light separators", () => {
		const modules = qrModules("https://example.test/#k=ab");
		expect(modules).toHaveLength(25); // version 2 holds 26 bytes at level M
		const finder = [
			[1, 1, 1, 1, 1, 1, 1],
			[1, 0, 0, 0, 0, 0, 1],
			[1, 0, 1, 1, 1, 0, 1],
			[1, 0, 1, 1, 1, 0, 1],
			[1, 0, 1, 1, 1, 0, 1],
			[1, 0, 0, 0, 0, 0, 1],
			[1, 1, 1, 1, 1, 1, 1],
		];
		const read = (left: number, top: number) =>
			finder.map((row, y) => row.map((_, x) => (modules[top + y][left + x] ? 1 : 0)));
		expect(read(0, 0)).toEqual(finder);
		expect(read(18, 0)).toEqual(finder);
		expect(read(0, 18)).toEqual(finder);
		for (let i = 8; i < 17; i++) {
			expect(modules[6][i]).toBe(i % 2 === 0);
			expect(modules[i][6]).toBe(i % 2 === 0);
		}
		expect(modules[17][8]).toBe(true);
		expect(modules[7].slice(0, 8).every((dark) => !dark)).toBe(true);
	});

	it("grows to larger versions for longer links and refuses the impossible", () => {
		expect(qrModules("x".repeat(100))).toHaveLength(41); // version 6 holds 108 bytes at level M
		expect(() => qrModules("x".repeat(3000))).toThrow(/Too long/);
	});

	it("renders half-block text with a quiet zone", () => {
		const lines = qrText("hi").split("\n");
		expect(lines).toHaveLength(13); // 21 modules plus a 2-module quiet zone on each side, two rows per line
		expect(lines.every((line) => line.length === 25)).toBe(true);
		expect(lines[0]).toBe(" ".repeat(25));
		// Module rows 0 and 1 of the top-left finder: a full dark row over a row dark only at its ends.
		expect(lines[1].slice(2, 9)).toBe("█▀▀▀▀▀█");
	});
});
