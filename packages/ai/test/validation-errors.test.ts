import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { JsonObject, Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const view = Type.Union([Type.Literal("files"), Type.Literal("content"), Type.Literal("count")]);
const query = Type.Union([
	Type.Object({ view: Type.Literal("content"), path: Type.String() }, { additionalProperties: false }),
	Type.Object(
		{ view: Type.Literal("files"), path: Type.String(), cursor: Type.String() },
		{ additionalProperties: false },
	),
]);
const tool: Tool = {
	name: "search",
	description: "search",
	parameters: Type.Object({ queries: Type.Array(query), mode: view }, { additionalProperties: false }),
};

function call(args: JsonObject): ToolCall {
	return { type: "toolCall", id: "1", name: "search", arguments: args };
}

function failure(args: JsonObject): string {
	try {
		validateToolArguments(tool, call(args));
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected validation to fail");
}

describe("validation error messages", () => {
	it("names the failing path and the allowed literal values", () => {
		const message = failure({ queries: [{ view: "content", path: "a" }], mode: "bogus" });
		expect(message).toContain('mode: expected one of "files", "content", "count"');
		expect(message).not.toContain("anyOf");
	});

	it("reports only the closest alternative of a union instead of every branch", () => {
		const message = failure({ queries: [{ view: "files", path: "a" }], mode: "files" });
		expect(message).toContain("queries.0.cursor: must have required properties cursor");
		expect(message).not.toContain("must match a schema in anyOf");
		expect(message).not.toContain("schema is false");
		expect(message).not.toContain('view: expected "content"');
	});

	it("names the allowed discriminator values when no alternative matches", () => {
		const message = failure({ queries: [{ view: "count", path: "a" }], mode: "files" });
		expect(message).toContain('queries.0.view: expected one of "content", "files"');
	});

	it("names unexpected properties", () => {
		const message = failure({ queries: [], mode: "files", extra: 1 });
		expect(message).toContain("root: unexpected property extra");
	});

	describe("a field sent inside a nested object that the input takes at the top level", () => {
		const paging: Tool = {
			name: "localSearch",
			description: "search",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					queries: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["path"],
							properties: { path: { type: "string" } },
						},
					},
					cursor: { type: "string" },
				},
			},
		};
		const send = (args: JsonObject): string => {
			try {
				validateToolArguments(paging, { type: "toolCall", id: "1", name: "localSearch", arguments: args });
			} catch (error) {
				return (error as Error).message;
			}
			throw new Error("expected validation to fail");
		};

		it("names the correct form first, with the value that was sent", () => {
			const message = send({ queries: [{ cursor: "abc" }] });
			const lines = message.split("\n");
			expect(lines[1]).toBe(
				'  - queries.0.cursor: goes at the top level of the input, not inside queries.0: {"cursor":"abc"}',
			);
			expect(message).toContain("queries.0: unexpected property cursor");
		});

		it("says nothing of the kind for a field the top level does not take", () => {
			expect(send({ queries: [{ path: "a", other: 1 }] })).not.toContain("goes at the top level");
		});

		it("does not retype a long value", () => {
			const message = send({ queries: [{ cursor: "x".repeat(5_000) }] });
			expect(message).toContain('not inside queries.0: "cursor"');
			expect(message.length).toBeLessThan(3_000);
		});

		it("accepts the corrected form", () => {
			expect(
				validateToolArguments(paging, { type: "toolCall", id: "1", name: "localSearch", arguments: { cursor: "abc" } }),
			).toEqual({ cursor: "abc" });
		});
	});

	it("caps the echoed arguments and reports how much was omitted", () => {
		const message = failure({ queries: [{ view: "content", path: "x".repeat(20_000) }], mode: "bogus" });
		expect(message.length).toBeLessThan(3_000);
		expect(message).toMatch(/Received arguments \(first 1500 of \d+ characters; \d+ more omitted\)/);
	});

	it("echoes short arguments in full", () => {
		expect(failure({ queries: [], mode: "bogus" })).toContain('Received arguments:\n{"queries":[],"mode":"bogus"}');
	});
});
