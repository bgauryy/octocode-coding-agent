import { describe, expect, it } from "vitest";
import {
	MAX_ECHOED_ARGUMENTS_CHARS,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	parseToolCallArguments,
} from "../src/utils/json-parse.ts";

describe("parseStreamingJson", () => {
	// #10868
	it("keeps invalid \\u escapes as literal text without dropping fields", () => {
		expect(parseStreamingJson(String.raw`{"text":"\url{x}"}`)).toEqual({ text: "\\url{x}" });
		expect(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`)).toEqual({
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
	});

	it("decodes valid \\u escapes", () => {
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`)).toEqual({ text: "café \\url" });
	});

	it("omits a \\u escape that is cut off mid-stream", () => {
		expect(parseStreamingJson(String.raw`{"text":"ab\u00`)).toEqual({ text: "ab" });
	});
});

// #10897
describe("parseToolCallArguments", () => {
	it("parses complete JSON and repairs invalid escapes", () => {
		expect(parseToolCallArguments(String.raw`{"kind":"seek","note":"\url"}`)).toEqual({
			arguments: { kind: "seek", note: "\\url" },
		});
	});

	it("uses empty arguments for empty text", () => {
		expect(parseToolCallArguments("")).toEqual({ arguments: {} });
	});

	it("does not keep the valid prefix of malformed JSON", () => {
		const raw = '{"action":"apply","actions":[{"kind":"seek","time":.5}]}';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toMatch(/\n\nReceived arguments:\n/);
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("does not complete cut-off JSON", () => {
		const raw = '{"kind":"seek","clipId":"clip-fl';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("rejects JSON that is not an object", () => {
		expect(parseToolCallArguments("[1,2]")).toEqual({
			arguments: {},
			argumentsError: "Tool arguments must be a JSON object\n\nReceived arguments:\n[1,2]",
		});
	});
});

describe("parseStreamingJsonThrottled", () => {
	function streamLargeArguments(totalChars: number, deltaChars: number) {
		const content = 'line of text with \\n escapes and \\"quotes\\"\\n'.repeat(Math.ceil(totalChars / 40));
		const text = `{"path":"a.txt","content":"${content}","mode":"w"}`;
		let partialJson = "";
		let args: Record<string, unknown> | undefined;
		let parses = 0;
		const surfaced: Record<string, unknown>[] = [];
		const start = performance.now();
		for (let index = 0; index < text.length; index += deltaChars) {
			partialJson += text.slice(index, index + deltaChars);
			const next = parseStreamingJsonThrottled(args, partialJson);
			if (next !== args) {
				parses++;
				surfaced.push(next);
			}
			args = next;
		}
		return { text, args, parses, surfaced, elapsedMs: performance.now() - start };
	}

	// Measured about 60 ms alone (12 s before throttling); the bound leaves room for a loaded test run.
	it("parses 100 KB of arguments streamed in small deltas without quadratic cost", () => {
		const { elapsedMs, parses, text } = streamLargeArguments(100_000, 10);
		expect(text.length).toBeGreaterThan(100_000);
		expect(elapsedMs).toBeLessThan(2_000);
		expect(parses).toBeLessThan(600);
	});

	it("still surfaces partial arguments while a small call streams", () => {
		let partialJson = '{"path":"src/a.ts"';
		const first = parseStreamingJsonThrottled(undefined, partialJson);
		expect(first).toEqual({ path: "src/a.ts" });
		partialJson += ',"content":"hel';
		const second = parseStreamingJsonThrottled(first, partialJson);
		expect(second).toEqual({ path: "src/a.ts", content: "hel" });
	});

	it("surfaces partial arguments of a large call, lagging by a bounded amount", () => {
		const { surfaced, args } = streamLargeArguments(100_000, 10);
		const partials = surfaced.filter((value) => typeof value.content === "string");
		expect(partials.length).toBeGreaterThan(10);
		const lengths = partials.map((value) => (value.content as string).length);
		expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
		expect(args).toBeDefined();
	});

	it("re-parses when the text is replaced by a shorter or different one", () => {
		const big = `{"content":"${"x".repeat(20_000)}"`;
		const first = parseStreamingJsonThrottled(undefined, big);
		expect(parseStreamingJsonThrottled(first, '{"content":"y"}')).toEqual({ content: "y" });
	});

	it("leaves the exact final parse to parseToolCallArguments", () => {
		const { text } = streamLargeArguments(50_000, 10);
		const exact = parseToolCallArguments(text);
		expect(exact.argumentsError).toBeUndefined();
		expect(exact.arguments).toEqual(JSON.parse(text));
	});
});

describe("parseToolCallArguments error echo", () => {
	it("caps the echoed arguments and reports how much was omitted", () => {
		const raw = `{"content":"${"x".repeat(40_000)}`;
		const result = parseToolCallArguments(raw);
		expect(result.argumentsError).toBeDefined();
		expect(result.argumentsError!.length).toBeLessThan(MAX_ECHOED_ARGUMENTS_CHARS + 500);
		expect(result.argumentsError).toContain(`first ${MAX_ECHOED_ARGUMENTS_CHARS} of ${raw.length} characters`);
	});
});
