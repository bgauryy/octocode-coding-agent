import { expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	ApplicationContentBlockSchema,
	applicationContentText,
	layoutPurposes,
	resultPurposeData,
	returnedPurpose,
	returnedPurposes,
} from "../src/content.ts";
import { ApplicationCommandSchema, applicationCommandFingerprint, parseApplicationFrame } from "../src/application.ts";

it("round trips ordered rich content and explicit failures through application frames", () => {
	const content = [
		{
			id: "m:0",
			type: "text",
			text: "Source",
			annotations: [{ type: "url_citation", url: "https://example.com", startIndex: 0, endIndex: 6 }],
		},
		{ id: "m:1", type: "thinking", text: "Summary", redacted: false },
		{ id: "m:2", type: "image", asset: { id: "asset", mimeType: "image/png", size: 10 } },
		{ id: "m:3", type: "toolCall", toolCallId: "t", name: "read", arguments: { path: "file.ts" } },
		{ id: "m:4", type: "unsupported", providerType: "future_format", text: "A future format" },
	];
	const frame = {
		protocolVersion: 1,
		cursor: { sessionId: "s", epoch: "e", sequence: 1 },
		at: 1,
		type: "event",
		event: {
			type: "message.completed",
			message: {
				id: "m",
				role: "assistant",
				text: "Source",
				complete: true,
				content,
				status: "failed",
				errorMessage: "Provider failed",
				usage: { input: 10 },
			},
		},
	};
	expect(parseApplicationFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
	expect(Value.Check(ApplicationContentBlockSchema, { id: "bad", type: "image", data: "raw" })).toBe(false);
});

it("accepts attachment references and binds idempotency to attachment identity", () => {
	const command = { id: "request", sessionId: "s", action: "prompt" as const, text: "", attachments: ["asset-a"] };
	expect(Value.Check(ApplicationCommandSchema, command)).toBe(true);
	expect(Value.Check(ApplicationCommandSchema, { ...command, attachments: [] })).toBe(false);
	expect(Value.Check(ApplicationCommandSchema, { ...command, path: "/private/file" })).toBe(false);
	expect(applicationCommandFingerprint(command)).not.toBe(
		applicationCommandFingerprint({ ...command, attachments: ["asset-b"] }),
	);
});

it("gives text-only consumers a visible fallback for non-text content", () => {
	expect(
		applicationContentText([
			{ id: "a", type: "image", asset: { id: "i", mimeType: "image/png", size: 10 } },
			{ id: "b", type: "thinking", text: "", redacted: true },
			{ id: "c", type: "unsupported", providerType: "future", text: "" },
		]),
	).toBe("[Image: image/png]\n[Reasoning redacted]\n[Unsupported content: future]");
});

it("reads an external call's purpose only from the data its result returns", () => {
	expect(returnedPurpose({ content: [], structuredContent: { mainGoal: " find the parser ", reason: "x" } })).toBe(
		"find the parser",
	);
	expect(returnedPurpose({ results: [{ index: 0, data: { reasoning: "why this row" } }] })).toBe("why this row");
	expect(returnedPurpose({ results: [{ reason: "row reason" }] })).toBe("row reason");
	expect(returnedPurpose({ content: [], structuredContent: { results: [{ data: { files: [] } }] } })).toBeUndefined();
	expect(returnedPurpose({ mainGoal: "  " })).toBeUndefined();
	expect(returnedPurpose("text")).toBeUndefined();
	expect(returnedPurpose(undefined)).toBeUndefined();
});

it("lists every purpose a result returns, per row, from its own data only", () => {
	expect(returnedPurposes({ mainGoal: " find it ", reasoning: "because" })).toEqual([
		{ mainGoal: "find it", reasoning: "because" },
	]);
	// Rows keep their own `index`, else their position; a row's own text comes before its `data`'s; `reason` fills in.
	expect(
		returnedPurposes({
			results: [
				{ index: 4, mainGoal: "g1", reasoning: "r1" },
				{ data: { mainGoal: "g2" }, reason: "r2" },
				{ index: 7, data: { reasoning: "r3" } },
			],
		}),
	).toEqual([
		{ row: 4, mainGoal: "g1", reasoning: "r1" },
		{ row: 1, mainGoal: "g2", reasoning: "r2" },
		{ row: 7, reasoning: "r3" },
	]);
	// A top-level goal beside rows, inside a `structuredContent` wrapper.
	expect(
		returnedPurposes({ content: [], structuredContent: { mainGoal: "top", results: [{ reasoning: "row" }] } }),
	).toEqual([{ mainGoal: "top" }, { row: 0, reasoning: "row" }]);
});

it("drops empty values, duplicate entries and non-records from the returned purposes", () => {
	// A result that is itself the row list, bare or inside the stored MCP result.
	expect(returnedPurposes([{ mainGoal: "first" }, { index: 4, data: { reasoning: "second" } }, "text"])).toEqual([
		{ row: 0, mainGoal: "first" },
		{ row: 4, reasoning: "second" },
	]);
	expect(returnedPurposes({ content: [], structuredContent: [{ mainGoal: "wrapped" }] })).toEqual([
		{ row: 0, mainGoal: "wrapped" },
	]);
	expect(returnedPurposes([])).toEqual([]);
	expect(returnedPurposes("text")).toEqual([]);
	expect(returnedPurposes({ results: [{ mainGoal: "  ", reasoning: "" }, { data: {} }, "text", 3, null] })).toEqual([]);
	expect(returnedPurposes({ a: [{ index: 1, mainGoal: "g" }], b: [{ index: 1, mainGoal: "g" }] })).toEqual([
		{ row: 1, mainGoal: "g" },
	]);
	expect(returnedPurposes({ a: [{ mainGoal: "g" }, { mainGoal: "g" }] })).toEqual([
		{ row: 0, mainGoal: "g" },
		{ row: 1, mainGoal: "g" },
	]);
	for (const value of ["text", 4, null, undefined, ["x"]]) expect(returnedPurposes(value)).toEqual([]);
});

it("reads a result's purposes from its one JSON text when it has no structured content", () => {
	const text = (value: string) => ({ content: [{ type: "text", text: value }] });
	const rows = [{ index: 2, mainGoal: "find it", reasoning: "because" }];
	// One JSON object or array is read the way structured content is.
	expect(returnedPurposes(resultPurposeData(text(JSON.stringify({ results: rows }))))).toEqual([
		{ row: 2, mainGoal: "find it", reasoning: "because" },
	]);
	expect(returnedPurposes(resultPurposeData(text(`\n ${JSON.stringify(rows)} \n`)))).toEqual([
		{ row: 2, mainGoal: "find it", reasoning: "because" },
	]);
	expect(returnedPurpose(resultPurposeData(text('{"mainGoal":"top"}')))).toBe("top");
	// Structured content, when there is any, is the only source.
	const both = { ...text('{"mainGoal":"from text"}'), structuredContent: { mainGoal: "structured" } };
	expect(resultPurposeData(both)).toBe(both.structuredContent);
	expect(returnedPurposes(resultPurposeData({ ...text('{"mainGoal":"from text"}'), structuredContent: {} }))).toEqual(
		[],
	);
	// Anything that is not one JSON object or array shows nothing, and the text is left as it was.
	const prose = text('mainGoal: "find it"');
	for (const result of [
		prose,
		text('{"mainGoal":"cut'),
		text('"mainGoal"'),
		text("42"),
		text('{"mainGoal":"a"} and more'),
		{ content: [...text('{"mainGoal":"a"}').content, ...text('{"mainGoal":"b"}').content] },
		{ content: "plain" },
		{},
		undefined,
		null,
	]) {
		expect(resultPurposeData(result)).toBeUndefined();
		expect(returnedPurposes(resultPurposeData(result))).toEqual([]);
	}
	expect(prose.content[0].text).toBe('mainGoal: "find it"');
	// Blocks that are not text do not count; a displayed block (with its id) reads the same.
	const image = { type: "image", asset: { id: "a", mimeType: "image/png", size: 1 } };
	expect(resultPurposeData({ content: [image, { id: "t:1", type: "text", text: '{"mainGoal":"shown"}' }] })).toEqual({
		mainGoal: "shown",
	});
	// The same block is parsed once; new text in it is read again.
	const result = text('{"mainGoal":"first"}');
	expect(resultPurposeData(result)).toBe(resultPurposeData(result));
	result.content[0].text = '{"mainGoal":"second"}';
	expect(resultPurposeData(result)).toEqual({ mainGoal: "second" });
});

it("lays out a shared goal once and keeps per-row goals with their rows", () => {
	const shared = [
		{ row: 0, mainGoal: "map the parser", reasoning: "entry point" },
		{ row: 1, mainGoal: "map the parser", reasoning: "its callers" },
	];
	expect(layoutPurposes(shared)).toEqual({
		shared: true,
		goal: "map the parser",
		rows: [
			{ row: 0, reasoning: "entry point" },
			{ row: 1, reasoning: "its callers" },
		],
		numbered: true,
	});
	expect(layoutPurposes([shared[0]]).numbered).toBe(false);
	const mixed = [
		{ row: 0, mainGoal: "a", reasoning: "x" },
		{ row: 1, mainGoal: "b" },
	];
	expect(layoutPurposes(mixed)).toEqual({ shared: false, rows: mixed, numbered: true });
	// What the title line already shows is left out; a row with nothing left is dropped.
	expect(layoutPurposes(shared, "map  the parser")).toEqual({
		shared: true,
		rows: [
			{ row: 0, reasoning: "entry point" },
			{ row: 1, reasoning: "its callers" },
		],
		numbered: true,
	});
	expect(layoutPurposes([{ mainGoal: "only goal" }], "only goal")).toEqual({ shared: true, rows: [], numbered: false });
	expect(layoutPurposes(mixed, "a").rows).toEqual([
		{ row: 0, reasoning: "x" },
		{ row: 1, mainGoal: "b" },
	]);
});
