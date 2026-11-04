import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentTool, AgentToolResult } from "../src/types.ts";

const assistantMessage = { role: "assistant", content: [] } as unknown as AssistantMessage;
const context = { messages: [], tools: [] };
const call = { type: "toolCall" as const, id: "t1", name: "work", arguments: {} };
const partial: AgentToolResult<undefined> = { content: [], details: undefined };

function toolWith(execute: AgentTool<any>["execute"]): AgentTool<any> {
	return { name: "work", label: "Work", description: "", parameters: Type.Object({}), execute };
}

/** Updates, then keeps running long enough for an unobserved rejection to be noticed, then ends as `end` says. */
const updatesThen = (end: () => AgentToolResult<any>) =>
	toolWith(async (_id, _args, _signal, onUpdate) => {
		onUpdate?.(partial);
		await new Promise((resolve) => setTimeout(resolve, 30));
		return end();
	});

describe("an update listener that fails while a tool runs", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		vi.restoreAllMocks();
	});

	it.each([
		[
			"rejects",
			async () => {
				throw new Error("listener failed");
			},
		],
		[
			"throws",
			() => {
				throw new Error("listener failed");
			},
		],
	])("keeps the tool's result, raises no unhandled rejection and reports it, when it %s", async (_how, onUpdate) => {
		const tool = updatesThen(() => ({ content: [{ type: "text", text: "done" }], details: undefined }));
		const outcome = await runToolCall(call, { tools: [tool], assistantMessage, context, onUpdate });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(outcome.isError).toBe(false);
		expect(outcome.result.content).toEqual([{ type: "text", text: "done" }]);
		expect(unhandled).toEqual([]);
		expect(console.error).toHaveBeenCalledWith("Tool update listener error (work):", expect.any(Error));
	});

	it("keeps a failing tool's own error too", async () => {
		const tool = updatesThen(() => {
			throw new Error("tool failed");
		});
		const outcome = await runToolCall(call, {
			tools: [tool],
			assistantMessage,
			context,
			onUpdate: async () => {
				throw new Error("listener failed");
			},
		});
		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: "tool failed" }]);
		expect(unhandled).toEqual([]);
	});

	it("still waits for a slow update to finish before the call ends", async () => {
		let delivered = false;
		const tool = updatesThen(() => ({ content: [], details: undefined }));
		await runToolCall(call, {
			tools: [tool],
			assistantMessage,
			context,
			onUpdate: async () => {
				await new Promise((resolve) => setTimeout(resolve, 80));
				delivered = true;
			},
		});
		expect(delivered).toBe(true);
	});
});
