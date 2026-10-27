import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const define = (inputSchema: Record<string, unknown>) =>
	createMcpToolDefinition({
		server: "octocode",
		tool: { name: "localFetch", inputSchema },
		name: "mcp__octocode__localFetch",
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => {
			throw new Error("not called");
		},
	});

// Every native tool requires `reason`, so models add it to MCP calls too; servers that forbid extra keys rejected
// those calls ("reason: schema is false") 4 times in one session.
describe("MCP tool arguments", () => {
	it("drops a top-level reason the server schema does not declare, before validation", () => {
		const tool = define({ type: "object", properties: { path: { type: "string" } }, additionalProperties: false });
		expect(tool.prepareArguments?.({ path: "a.ts", reason: "read it" })).toEqual({ path: "a.ts" });
	});

	it("keeps reason when the server declares it, and leaves other arguments alone", () => {
		expect(define({ type: "object", properties: { reason: { type: "string" } } }).prepareArguments).toBeUndefined();
		const strict = define({ type: "object", properties: { path: { type: "string" } } });
		const args = { path: "a.ts" };
		expect(strict.prepareArguments?.(args)).toBe(args);
		expect(strict.prepareArguments?.("raw")).toBe("raw");
	});
});
