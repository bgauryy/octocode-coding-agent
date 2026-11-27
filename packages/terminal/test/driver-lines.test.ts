import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readDriverLines } from "../src/driver-lines.ts";

describe("bounded completion protocol lines", () => {
	it("decodes split UTF-8 and accepts LF, CR and split CRLF", () => {
		const input = new PassThrough();
		const lines: string[] = [];
		const stop = readDriverLines(
			input,
			(line) => lines.push(line),
			() => {
				throw new Error("unexpected overflow");
			},
		);
		const unicode = Buffer.from("工具");
		input.write(unicode.subarray(0, 1));
		input.write(unicode.subarray(1));
		input.write("\r");
		input.write("\nsecond\rthird\nfourth\r\n");
		expect(lines).toEqual(["工具", "second", "third", "fourth"]);
		stop();
		input.destroy();
	});

	it("bounds a line across chunks and stops reading after overflow", () => {
		const input = new PassThrough();
		const lines: string[] = [];
		let overflows = 0;
		readDriverLines(
			input,
			(line) => lines.push(line),
			() => overflows++,
		);
		input.write("x".repeat(64 * 1024));
		input.write("x\nlater\n");
		expect(overflows).toBe(1);
		expect(lines).toEqual([]);
		expect(input.listenerCount("data")).toBe(0);
		input.destroy();
	});

	it("disposal inside a line handler drops the remainder of the chunk", () => {
		const input = new PassThrough();
		const lines: string[] = [];
		const stop = readDriverLines(
			input,
			(line) => {
				lines.push(line);
				stop();
			},
			() => {},
		);
		input.write("first\nsecond\n");
		expect(lines).toEqual(["first"]);
		expect(input.listenerCount("data")).toBe(0);
		input.destroy();
	});
});
