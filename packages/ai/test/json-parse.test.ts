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
			rawArguments: "[1,2]",
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

// B288: long nested `agent` calls failed with "Unexpected non-whitespace character after JSON" one character before the end.
describe("parseToolCallArguments text after the object", () => {
	const nested = (task: string) => JSON.stringify({ type: "task", input: { goal: "g", task, background: true } });

	it.each(["}", "}}", "} \n", "]", "}]}"])("accepts a complete object followed only by closers %j", (extra) => {
		const raw = nested('say "}" and {braces}\nnext') + extra;
		expect(() => JSON.parse(raw)).toThrow(/after JSON/);
		const result = parseToolCallArguments(raw);
		expect(result.argumentsError).toBeUndefined();
		expect(result.arguments).toEqual(JSON.parse(nested('say "}" and {braces}\nnext')));
	});

	it("accepts extra closers after a long object whose text contains braces and quotes", () => {
		const task = 'line {with} "quotes" and \\ backslash\n'.repeat(120);
		const result = parseToolCallArguments(`${nested(task)}}`);
		expect(result.argumentsError).toBeUndefined();
		expect((result.arguments.input as { task: string }).task).toBe(task);
	});

	it("refuses a second object after the first, as when parallel calls merge", () => {
		const raw = `${nested("one")}${nested("two")}`;
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toContain("complete JSON object followed by unexpected text");
		expect(result.argumentsError).toContain(JSON.stringify(nested("two").slice(0, 100)));
	});

	it.each(['}, "extra": 1}', " tail", "}x", "}\n```"])("refuses other text after the object %j", (extra) => {
		const result = parseToolCallArguments(nested("one") + extra);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toContain("followed by unexpected text");
	});

	it("refuses closers after text that is not a complete object", () => {
		expect(parseToolCallArguments('{"a":{"b":1}').arguments).toEqual({});
		expect(parseToolCallArguments('{"a":.5}}').argumentsError).toBeDefined();
		expect(parseToolCallArguments("}").argumentsError).toBeDefined();
	});

	it("shows the end of long malformed arguments, where the stray text is", () => {
		const raw = `${nested("x".repeat(5000))}} TRAILING-MARKER`;
		const result = parseToolCallArguments(raw);
		expect(result.argumentsError).toContain('"} TRAILING-MARKER"');
		expect(result.argumentsError).toContain(`Last 200 characters:\n${raw.slice(-200)}`);
		expect(result.argumentsError!.endsWith(raw.slice(-200))).toBe(true);
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

	it("keeps the whole text on the call although the echo is capped", () => {
		const raw = `{"content":"${"x".repeat(40_000)}`;
		expect(parseToolCallArguments(raw).rawArguments).toBe(raw);
	});

	it("sets no raw text for arguments that parse", () => {
		expect(parseToolCallArguments('{"a":1}')).toEqual({ arguments: { a: 1 } });
	});

	it("names the structural fault of malformed text", () => {
		expect(parseToolCallArguments('{"q":[{"a":"b"}').argumentsError).toContain(
			"ends with 2 unclosed brackets; it needs `]}` at the end",
		);
	});
});
