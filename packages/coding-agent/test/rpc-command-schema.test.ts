import { describe, expect, it } from "vitest";
import { RpcCommandSchema, validateRpcCommand } from "../src/modes/rpc/rpc-command-schema.ts";

describe("validateRpcCommand", () => {
	it("accepts well-formed commands, with or without an id", () => {
		expect(validateRpcCommand({ type: "get_state" })).toEqual({ ok: true });
		expect(validateRpcCommand({ id: "1", type: "prompt", message: "hi", streamingBehavior: "steer" })).toEqual({
			ok: true,
		});
		expect(
			validateRpcCommand({
				type: "steer",
				message: "x",
				images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			}),
		).toEqual({ ok: true });
	});

	it("rejects an unknown command type and echoes the id", () => {
		expect(validateRpcCommand({ id: "7", type: "frobnicate" })).toEqual({
			ok: false,
			commandType: "frobnicate",
			id: "7",
			message: "Unknown command: frobnicate",
		});
	});

	it("names a missing required field", () => {
		const result = validateRpcCommand({ id: "2", type: "set_model", provider: "anthropic" });
		expect(result).toMatchObject({ ok: false, commandType: "set_model", id: "2" });
		expect(result.ok ? "" : result.message).toContain('missing required field "modelId"');
	});

	it("names a field with the wrong value", () => {
		const result = validateRpcCommand({ type: "set_thinking_level", level: "turbo" });
		expect(result.ok ? "" : result.message).toContain('field "level"');
		const nested = validateRpcCommand({
			type: "prompt",
			message: "x",
			images: [{ type: "image", data: 1, mimeType: "a" }],
		});
		expect(nested.ok ? "" : nested.message).toContain('field "images.0.data"');
	});

	it("rejects non-object input and a missing or non-string type", () => {
		for (const value of [null, 3, "prompt", ["prompt"]]) {
			expect(validateRpcCommand(value)).toMatchObject({ ok: false, commandType: "invalid" });
		}
		const result = validateRpcCommand({ id: "x", type: 5 });
		expect(result).toMatchObject({ ok: false, commandType: "invalid", id: "x" });
		expect(result.ok ? "" : result.message).toContain('"type"');
		expect(validateRpcCommand({ id: 5, type: "prompt" })).toMatchObject({ ok: false, id: undefined });
	});

	it("covers every command in the schema union", () => {
		const types = RpcCommandSchema.anyOf.map((schema) => schema.properties.type.const);
		expect(new Set(types).size).toBe(types.length);
		for (const type of types) {
			const result = validateRpcCommand({ type });
			expect(result.ok ? "" : result.message).not.toContain("Unknown command");
		}
	});
});

it("accepts optional compaction focus and structured planning controls", () => {
	expect(validateRpcCommand({ type: "compact" })).toEqual({ ok: true });
	expect(validateRpcCommand({ type: "compact", customInstructions: "Preserve tests." })).toEqual({ ok: true });
	expect(validateRpcCommand({ type: "compact", customInstructions: "x".repeat(16_001) }).ok).toBe(false);
	expect(validateRpcCommand({ type: "plan", action: "approve", revision: 3 }).ok).toBe(true);
	expect(validateRpcCommand({ type: "plan", action: "execute" }).ok).toBe(false);
});
