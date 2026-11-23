import { describe, expect, it } from "vitest";
import type { JsonValue, Tool } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

/** One-field tool whose `value` has `schema`, validated with `value`. */
function validate(schema: Tool["parameters"], value: unknown): unknown {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: { type: "object", properties: { value: schema }, required: ["value"], additionalProperties: false },
	};
	return validateToolArguments(tool, {
		type: "toolCall",
		id: "t1",
		name: "echo",
		arguments: { value: value as JsonValue },
	}).value;
}

describe("near-miss coercion", () => {
	const intent = { type: "string", enum: ["list", "tools", "resources", "read"] };

	it("maps a value that differs from one allowed value only by case or a trailing s", () => {
		expect(validate(intent, "tool")).toBe("tools");
		expect(validate(intent, "Lists")).toBe("list");
		expect(validate(intent, "READ")).toBe("read");
	});

	it("still refuses a value that matches no allowed value, or two", () => {
		expect(() => validate(intent, "fetch")).toThrow(/value/);
		expect(() => validate({ type: "string", enum: ["item", "items"] }, "Item")).toThrow(/value/);
	});

	it("takes one string where a list of strings is declared as that one item", () => {
		expect(validate({ type: "array", items: { type: "string" } }, "octocode-debugging")).toEqual([
			"octocode-debugging",
		]);
		expect(validate({ type: "array", items: { type: "string", enum: ["a", "bs"] } }, "b")).toEqual(["bs"]);
		expect(validate({ type: "array", items: { type: "string" } }, '["x","y"]')).toEqual(["x", "y"]);
	});

	it("leaves a string where a list of objects is declared to fail", () => {
		expect(() => validate({ type: "array", items: { type: "object", properties: {} } }, "x")).toThrow(/value/);
	});
});
