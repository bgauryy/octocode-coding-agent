import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

function define(inputSchema: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	const tool = createMcpToolDefinition({
		server: "configured-service",
		tool: { name: "lookup", inputSchema },
		name: "mcp__configured_service__lookup",
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => ({
			callTool: async (_name, args) => {
				sent.push(args);
				return { content: [{ type: "text" as const, text: "OK" }] };
			},
		}),
	});
	const validate = (args: JsonObject) =>
		validateToolArguments(tool as never, { type: "toolCall", id: "c", name: tool.name, arguments: args });
	return { tool, sent, validate };
}

describe("server-owned MCP input", () => {
	it.each<{ name: string; properties: Record<string, unknown>; args: JsonObject }>([
		{ name: "no reason field", properties: { key: { type: "string" } }, args: { key: "item" } },
		{
			name: "optional reason omitted",
			properties: { key: { type: "string" }, reason: { type: "number" } },
			args: { key: "item" },
		},
		{
			name: "server-defined reason type",
			properties: { key: { type: "string" }, reason: { type: "number" } },
			args: { key: "item", reason: 17 },
		},
	])("forwards $name without adding or rewriting fields", async ({ properties, args }) => {
		const { tool, sent, validate } = define({
			type: "object",
			properties,
			required: ["key"],
			additionalProperties: false,
		});
		const validated = validate(args);
		await tool.execute("c", validated, undefined, undefined, {} as never);
		expect(sent).toEqual([args]);
	});

	it("drops a native-style reason the server's closed schema neither declares nor accepts, before validation", async () => {
		const { tool, sent, validate } = define({
			type: "object",
			properties: { key: { type: "string" } },
			required: ["key"],
			additionalProperties: false,
		});
		const prepared = tool.prepareArguments?.({ key: "item", reason: "why I look it up" }) as JsonObject;
		expect(prepared).toEqual({ key: "item" });
		await tool.execute("c", validate(prepared), undefined, undefined, {} as never);
		expect(sent).toEqual([{ key: "item" }]);
		// A reason that is not the native string, or a closed root alternative's own reason, stays for validation to judge.
		expect(tool.prepareArguments?.({ key: "item", reason: 3 })).toEqual({ key: "item", reason: 3 });
		const alternatives = define({
			anyOf: [
				{ properties: { reason: { type: "string" } }, additionalProperties: false },
				{ properties: { key: { type: "string" } }, additionalProperties: false },
			],
		});
		expect(alternatives.tool.prepareArguments).toBeUndefined();
	});

	it("never drops a reason the server declares, or one an open schema accepts", () => {
		const declared = define({
			type: "object",
			properties: { reason: { type: "string" } },
			additionalProperties: false,
		});
		const open = define({ type: "object", properties: { key: { type: "string" } } });
		expect(declared.tool.prepareArguments).toBeUndefined();
		expect(open.tool.prepareArguments).toBeUndefined();
	});

	it("requires reason only when the server's schema requires it", () => {
		const { validate } = define({ type: "object", properties: { reason: { type: "string" } }, required: ["reason"] });
		expect(() => validate({})).toThrow(/reason/);
		expect(validate({ reason: "server requirement" })).toEqual({ reason: "server requirement" });
	});

	it("preserves additional fields accepted by an open server schema", async () => {
		const { tool, sent, validate } = define({
			type: "object",
			properties: { key: { type: "string" } },
			required: ["key"],
		});
		const args = { key: "item", reason: { serverData: true }, extra: 42 };
		await tool.execute("c", validate(args), undefined, undefined, {} as never);
		expect(sent).toEqual([args]);
		const hint = tool.validationHint?.({ envelope: true, properties: ["key"] });
		expect(hint).toContain('requires {"key":"..."}');
		expect(hint).not.toContain("no other");
		expect(hint).not.toContain("reason");
	});

	it("does not hide a server requirement that has no property definition", () => {
		const { tool } = define({ type: "object", required: ["reason"] });
		expect(tool.validationHint?.({ envelope: true, properties: ["reason"] })).toContain('requires {"reason":...}');
	});

	it("keeps root requirements alongside the server's alternatives", () => {
		const { tool } = define({
			type: "object",
			properties: { tenant: { type: "string" } },
			required: ["tenant"],
			anyOf: [
				{ properties: { id: { type: "number" } }, required: ["id"] },
				{ properties: { slug: { type: "string" } }, required: ["slug"] },
			],
		});
		expect(tool.validationHint?.({ envelope: true, properties: ["tenant"] })).toContain(
			'requires {"tenant":"...","id":...} or {"tenant":"...","slug":"..."}',
		);
	});
});
