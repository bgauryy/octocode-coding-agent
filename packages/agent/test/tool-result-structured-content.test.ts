import { expect, it } from "vitest";
import { createToolResultMessage } from "../src/agent-loop/events.ts";

it("keeps structured output in serializable tool history independently of display content", () => {
	const structuredContent = { content: [{ type: "resource", uri: "fixture://result" }], records: [{ id: 42 }] };
	const message = createToolResultMessage({
		toolCall: { type: "toolCall", id: "call", name: "mcp_fixture", arguments: {} },
		result: { content: [{ type: "text", text: "Summary" }], details: { server: "fixture" }, structuredContent },
		isError: false,
	});
	const restored = JSON.parse(JSON.stringify(message));
	expect(restored.structuredContent).toEqual(structuredContent);
	expect(restored.content).toEqual([{ type: "text", text: "Summary" }]);
});
