import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import { ABANDONED_MESSAGE } from "../src/agent-loop/tool-call.ts";
import type { AgentTool, AgentToolResult } from "../src/types.ts";

const assistantMessage = { role: "assistant", content: [] } as unknown as AssistantMessage;
const context = { messages: [], tools: [] };
const call = { type: "toolCall" as const, id: "t1", name: "hang", arguments: {} };

function toolWith(execute: AgentTool<any>["execute"]): AgentTool<any> {
	return { name: "hang", label: "Hang", description: "", parameters: Type.Object({}), execute };
}

describe("aborting a running tool", () => {
	it("ends within about 100 ms when the tool never settles and ignores the signal", async () => {
		const controller = new AbortController();
		const tool = toolWith(() => new Promise<never>(() => {}));
		setTimeout(() => controller.abort(), 20);
		const startedAt = Date.now();
		const outcome = await runToolCall(call, { tools: [tool], assistantMessage, context, signal: controller.signal });
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: ABANDONED_MESSAGE }]);
	});

	it("ignores late updates, results and rejections from the abandoned tool without unhandled rejections", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const controller = new AbortController();
			const updates: unknown[] = [];
			const tool = toolWith(
				(_id, _args, _signal, onUpdate) =>
					new Promise<AgentToolResult<any>>((_resolve, reject) => {
						setTimeout(() => {
							onUpdate?.({ content: [{ type: "text", text: "late" }], details: undefined });
							reject(new Error("late failure"));
						}, 150);
					}),
			);
			setTimeout(() => controller.abort(), 10);
			const outcome = await runToolCall(call, {
				tools: [tool],
				assistantMessage,
				context,
				signal: controller.signal,
				onUpdate: (update) => void updates.push(update),
			});
			expect(outcome.result.content).toEqual([{ type: "text", text: ABANDONED_MESSAGE }]);
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(updates).toEqual([]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("keeps the result of a tool that honors the signal", async () => {
		const controller = new AbortController();
		const tool = toolWith(
			(_id, _args, signal) =>
				new Promise<AgentToolResult<any>>((resolve) => {
					signal?.addEventListener("abort", () =>
						resolve({ content: [{ type: "text", text: "partial output" }], details: undefined }),
					);
				}),
		);
		setTimeout(() => controller.abort(), 10);
		const outcome = await runToolCall(call, { tools: [tool], assistantMessage, context, signal: controller.signal });
		expect(outcome.result.content).toEqual([{ type: "text", text: "partial output" }]);
	});

	it("still runs normally without an abort", async () => {
		const tool = toolWith(async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }));
		const outcome = await runToolCall(call, { tools: [tool], assistantMessage, context });
		expect(outcome).toMatchObject({ isError: false, result: { content: [{ type: "text", text: "ok" }] } });
	});
});
