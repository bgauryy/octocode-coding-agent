import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	test("joins records split across chunks, including a character split between chunks", async () => {
		const lines: string[] = [];
		const bytes = Buffer.from('{"a":"é"}\n{"b":"line two"}\n{"c":3}');
		const chunks = [...bytes].map((byte) => Buffer.from([byte]));
		const stream = Readable.from(chunks);
		const done = new Promise<void>((resolve) => stream.on("end", resolve));
		attachJsonlLineReader(stream, (line) => lines.push(line));
		await done;
		expect(lines).toEqual(['{"a":"é"}', '{"b":"line two"}', '{"c":3}']);
	});

	test("reads a 64 MB record that arrives in 64 KB chunks in linear time", () => {
		// A get_messages response carrying base64 images can be tens of megabytes on one line. Rescanning the whole
		// buffer on every chunk made this quadratic: about 7 s for 64 MB on an M-series laptop, against well under 1 s.
		const stream = new Readable({ read() {} });
		const lengths: number[] = [];
		attachJsonlLineReader(stream, (line) => lengths.push(line.length));
		const chunk = Buffer.alloc(64 * 1024, 97);
		const started = performance.now();
		for (let i = 0; i < 1024; i++) stream.emit("data", chunk);
		stream.emit("data", Buffer.from("\n"));
		const elapsed = performance.now() - started;
		expect(lengths).toEqual([64 * 1024 * 1024]);
		expect(elapsed).toBeLessThan(3000);
	});
});
