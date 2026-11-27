import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/tool-definition.ts";
import type { McpToolCaller } from "../src/tools.ts";
import type { CallToolResult } from "../src/client/index.ts";

const outputSchema = {
	type: "object" as const,
	properties: { hits: { type: "number" } },
	required: ["hits"],
};

async function run(reply: CallToolResult, withSchema = true): Promise<string[]> {
	const caller: McpToolCaller = { callTool: async () => reply };
	const definition = createMcpToolDefinition({
		server: "fake",
		name: "fake__search",
		tool: { name: "search", inputSchema: { type: "object" }, ...(withSchema ? { outputSchema } : {}) },
		exposure: "direct",
		namespace: { name: "mcp__fake" },
		timeoutMs: 1000,
		getClient: async () => caller,
	} as never);
	const result = await definition.execute("id", {}, undefined, undefined, {} as never);
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

describe("outputSchema check", () => {
	it("appends a note naming the first mismatch and keeps the result", async () => {
		const text = await run({ content: [{ type: "text", text: "found" }], structuredContent: { hits: "many" } });
		expect(text[0]).toBe("found");
		expect(text.at(-1)).toMatch(/does not match the tool's outputSchema \(data\/hits must be number\)/);
	});
	it("adds no note when the content matches", async () => {
		const text = await run({ content: [{ type: "text", text: "found" }], structuredContent: { hits: 2 } });
		expect(text).toEqual(["found"]);
	});
	it("notes a reply that leaves out the structuredContent its outputSchema promises, but not an error reply", async () => {
		const text = await run({ content: [{ type: "text", text: "found" }] });
		expect(text[0]).toBe("found");
		expect(text.at(-1)).toMatch(/outputSchema \(structuredContent is missing\)/);
		const failed = await run({ content: [{ type: "text", text: "boom" }], isError: true });
		expect(failed).toEqual(["boom"]);
	});
	it("leaves a tool without an outputSchema unchanged", async () => {
		const text = await run({ content: [{ type: "text", text: "found" }], structuredContent: { hits: "many" } }, false);
		expect(text).toEqual(["found"]);
	});
});
