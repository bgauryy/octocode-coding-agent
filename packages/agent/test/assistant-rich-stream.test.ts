import {
	type AssistantMessage,
	type AssistantContent,
	createAssistantMessageEventStream,
	type Model,
} from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { streamAssistantResponse } from "../src/agent-loop/assistant-stream.ts";
import type { AgentContext, AgentEvent } from "../src/types.ts";

it("publishes artifacts and annotations before the provider finishes the response", async () => {
	const model = { id: "fixture", provider: "openai", api: "openai-responses" } as Model<"openai-responses">;
	const partial: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "pending",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const response = createAssistantMessageEventStream();
	const context: AgentContext = { messages: [], tools: [] };
	const events: AgentEvent[] = [];
	const pending = streamAssistantResponse(
		context,
		{ model, convertToLlm: () => [] },
		undefined,
		(event) => {
			events.push(structuredClone(event));
		},
		() => response,
	);
	try {
		response.push({ type: "start", partial });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const updates: AssistantContent[] = [
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			{ type: "text", text: "Source", annotations: [{ type: "citation", url: "https://example.invalid/source" }] },
		];
		for (const [contentIndex, content] of updates.entries()) {
			partial.content.push(content);
			response.push({ type: "content_update", contentIndex, partial });
			await new Promise<void>((resolve) => setImmediate(resolve));
			const latest = events.at(-1);
			expect(latest?.type).toBe("message_update");
			if (latest?.type !== "message_update") throw new Error("Missing live content update");
			if (latest.message.role !== "assistant") throw new Error("Expected an assistant message");
			expect(latest.assistantMessageEvent).toMatchObject({ type: "content_update", contentIndex });
			expect(latest.message.content).toEqual(updates.slice(0, contentIndex + 1));
			expect(events.some((event) => event.type === "message_end")).toBe(false);
		}
	} finally {
		partial.stopReason = "stop";
		response.push({ type: "done", reason: "stop", message: partial });
		response.end();
		await pending;
	}
	expect(context.messages).toEqual([partial]);
	expect(events.filter((event) => event.type === "message_update")).toHaveLength(2);
	expect(events.at(-1)?.type).toBe("message_end");
});
