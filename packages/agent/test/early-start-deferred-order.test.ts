import type { AssistantMessage, ToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { EarlyToolCalls } from "../src/agent-loop/early-start.ts";
import type { AgentLoopConfig, AgentTool, BeforeToolCallContext, BeforeToolCallResult } from "../src/types.ts";

it("defers queued early checks after an earlier async check needs the user", async () => {
	let release!: (result: BeforeToolCallResult) => void;
	const permission = new Promise<BeforeToolCallResult>((resolve) => {
		release = resolve;
	});
	const execute = vi.fn(async () => ({ content: [], details: undefined }));
	const tool: AgentTool = {
		name: "read",
		label: "Read",
		description: "",
		parameters: Type.Object({}),
		execute,
	};
	const beforeToolCall = vi.fn(async ({ toolCall }: BeforeToolCallContext) =>
		toolCall.id === "first" ? permission : undefined,
	);
	const early = new EarlyToolCalls(
		{ messages: [], tools: [tool] },
		{ beforeToolCall } as unknown as AgentLoopConfig,
		{ mayStart: () => true },
		undefined,
	);
	const calls: ToolCall[] = ["first", "second"].map((id) => ({
		type: "toolCall",
		id,
		name: "read",
		arguments: {},
	}));
	const partial = { role: "assistant", content: calls } as AssistantMessage;
	for (const [contentIndex, toolCall] of calls.entries()) {
		early.observe({ type: "toolcall_end", contentIndex, toolCall, partial });
		early.observe({ type: "text_start", contentIndex: contentIndex + 1, partial });
	}
	const runs = early.take(calls);
	release({ defer: true });
	const prepared = await Promise.all(runs.map((run) => run.preparation));
	await Promise.all(runs.map((run) => run.executed));
	early.dispose();
	expect(prepared.map((entry) => entry.kind)).toEqual(["deferred", "deferred"]);
	expect(beforeToolCall).toHaveBeenCalledTimes(1);
	expect(execute).not.toHaveBeenCalled();
});
