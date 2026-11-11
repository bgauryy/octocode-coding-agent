import type { AgentLoopConfig, AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { executeToolCalls } from "../../../agent/src/agent-loop/tool-batch.ts";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import { LOOP_HALT_AT, registerLoopGuard } from "../../src/octocode/loop-guard.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { createHarness, getMessageText } from "../suite/harness.ts";

/** The loop guard with its `loop` step run on `tool_call`, as the pipeline runs it first (`tool-gates.ts`). */
function loopGuard(api: ExtensionAPI): void {
	const loop = registerLoopGuard(api);
	api.on("tool_call", (event, ctx) => loop(event, ctx));
}

it.each(["invalid", "unknown", "valid"])("halts repeated %s calls through the real tool pipeline", async (kind) => {
	const fake = fakeHost();
	loopGuard(fake.api);
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
		extensionFactories: [loopGuard],
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
		// What print mode's exit code and RPC's outcome read.
		expect(harness.session.lastRunOutcome?.status).not.toBe("completed");
		expect(harness.session.lastRunOutcome?.errorMessage).toBe("Stopped by the loop guard.");
	} finally {
		harness.cleanup();
	}
});

it("runs the loop guard as the audited first step of the tool_call pipeline", async () => {
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd: "/repo" });
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
	permission.start(ctx);
	let hookRuns = 0;
	registerToolGates(fake.api, {
		loop: registerLoopGuard(fake.api),
		permission,
		provenance: { check: () => undefined },
		collab: { reservationGate: async () => undefined },
		hooks: {
			preToolUse: async () => {
				hookRuns++;
				return undefined;
			},
			hasPreToolUse: () => false,
		},
		sourcePolicy: { refresh: async () => undefined },
		activity: { checking: () => undefined },
		localReads: new Map(),
	} as unknown as ToolGatesOptions);
	const input = { query: "same" };
	const call = async (id: string) => {
		await fake.fire("tool_execution_start", { toolCallId: id, toolName: "sample", args: input }, ctx);
		const verdict = (await fake.fire("tool_call", { toolCallId: id, toolName: "sample", input }, ctx)) as
			| { block?: boolean; terminate?: boolean; reason?: string }
			| undefined;
		const content = [{ type: "text", text: verdict?.reason ?? "same" }];
		if (!verdict?.block) await fake.fire("tool_result", { toolCallId: id, content, isError: false }, ctx);
		const message = { role: "toolResult", toolCallId: id, toolName: "sample", content, isError: Boolean(verdict) };
		await fake.fire("message_end", { message }, ctx);
		return verdict;
	};
	for (let i = 1; i <= LOOP_HALT_AT; i++) expect(await call(`c${i}`)).toBeUndefined();
	const refused = await call("halt");
	expect(refused).toMatchObject({
		block: true,
		terminate: true,
		reason: expect.stringContaining("Loop guard: refused"),
	});
	// No later step ran for the refused call, and the refusal is in the permission audit (`/permissions log`).
	expect(hookRuns).toBe(LOOP_HALT_AT);
	expect(fake.entries.map((entry) => entry.data)).toContainEqual(
		expect.objectContaining({ allowed: false, via: "invariant", note: expect.stringContaining("Loop guard: refused") }),
	);
});
