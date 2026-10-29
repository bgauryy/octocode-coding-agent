import type { AgentLoopConfig, AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { executeToolCalls } from "../../../agent/src/agent-loop/tool-batch.ts";
import { LOOP_HALT_AT, registerLoopGuard } from "../../src/octocode/loop-guard.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { createHarness, getMessageText } from "../suite/harness.ts";

it.each(["invalid", "unknown", "valid"])("halts repeated %s calls through the real tool pipeline", async (kind) => {
	const fake = fakePi();
	registerLoopGuard(fake.pi);
	const ctx = fakeCtx({ cwd: "/repo" });
	const controller = new AbortController();
	ctx.abort = () => controller.abort();
	const tool: AgentTool = {
		name: "sample",
		label: "Sample",
		description: "Sample",
		parameters: Type.Object({ text: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "same" }], details: {} }),
	};
	const context = { messages: [], tools: [tool] };
	const config = {
		toolExecution: "sequential",
		beforeToolCall: ({ toolCall, args }) =>
			fake.fire("tool_call", { toolName: toolCall.name, toolCallId: toolCall.id, input: args }, ctx),
		afterToolCall: ({ toolCall, result, isError }) =>
			fake.fire("tool_result", { toolCallId: toolCall.id, content: result.content, isError }, ctx),
	} as AgentLoopConfig;
	let haltedAt: number | undefined;
	let finalText = "";
	for (let attempt = 1; attempt <= LOOP_HALT_AT + 3; attempt++) {
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `call-${attempt}`,
					name: kind === "unknown" ? "missing" : "sample",
					arguments: kind === "invalid" ? {} : { text: "same" },
				},
			],
		} as AssistantMessage;
		const result = await executeToolCalls(context, message, config, controller.signal, async (event) => {
			const replacement = (await fake.fire(event.type, event, ctx)) as
				| { message?: { content: Array<{ text?: string }> } }
				| undefined;
			if (replacement?.message) finalText = replacement.message.content.map((part) => part.text ?? "").join("\n");
		});
		if (result.terminate || controller.signal.aborted) {
			haltedAt = attempt;
			break;
		}
	}
	expect(haltedAt).toBe(LOOP_HALT_AT + 1);
	if (kind !== "valid") expect(finalText).toContain("Loop guard: refused");
});

it.each(["invalid", "unknown"])("settles a real session after repeated %s calls", async (kind) => {
	const tool: AgentTool = {
		name: "sample",
		label: "Sample",
		description: "Sample",
		parameters: Type.Object({ text: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "same" }], details: {} }),
	};
	const harness = await createHarness({
		tools: [tool],
		extensionFactories: [registerLoopGuard],
		settings: { retry: { enabled: false } },
	});
	await harness.session.bindExtensions({});
	harness.setResponses(
		Array.from({ length: LOOP_HALT_AT + 3 }, () =>
			fauxAssistantMessage([fauxToolCall(kind === "unknown" ? "missing" : "sample", {})], { stopReason: "toolUse" }),
		),
	);
	try {
		await harness.session.prompt("Run the sample");
		expect(harness.session.isIdle).toBe(true);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(LOOP_HALT_AT + 1);
		expect(getMessageText(results.at(-1)!)).toContain("Loop guard: refused");
	} finally {
		harness.cleanup();
	}
});
