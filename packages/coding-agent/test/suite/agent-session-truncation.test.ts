import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	MAX_LENGTH_CONTINUATIONS,
	MAX_TRUNCATED_TOOL_TURNS,
	TRUNCATED_TOOL_TURNS_MESSAGE,
} from "../../src/core/agent-session/length-continuation.ts";
import { createHarness } from "./harness.ts";

const noopTool = {
	name: "t",
	label: "t",
	description: "t",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
};

describe("replies cut off at the output limit", () => {
	it("ends the run after consecutive truncated tool-call turns and says why", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } }, tools: [noopTool] });
		const settled: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.push(event.outcome);
		});
		const cut = () => fauxAssistantMessage([fauxToolCall("t", {})], { stopReason: "length" });
		harness.setResponses([cut(), cut(), cut(), fauxAssistantMessage("never requested")]);
		await harness.session.prompt("go");
		await harness.session.settled();

		const outcome = harness.session.lastRunOutcome;
		expect(MAX_TRUNCATED_TOOL_TURNS).toBe(3);
		expect(outcome?.status).toBe("truncated");
		expect(outcome?.errorMessage).toBe(TRUNCATED_TOOL_TURNS_MESSAGE);
		expect(settled.at(-1)).toEqual(outcome);
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.cleanup();
	});

	it("a turn that is not cut resets the count", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } }, tools: [noopTool] });
		const cut = () => fauxAssistantMessage([fauxToolCall("t", {})], { stopReason: "length" });
		harness.setResponses([
			cut(),
			cut(),
			fauxAssistantMessage([fauxToolCall("t", {})], { stopReason: "toolUse" }),
			cut(),
			cut(),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		await harness.session.settled();
		expect(harness.session.lastRunOutcome?.status).toBe("completed");
		expect(harness.getPendingResponseCount()).toBe(0);
		harness.cleanup();
	});

	it("continues a text reply that filled the output limit, up to the continuation budget", async () => {
		// A one-token limit: any estimated reply fills it, so the stop reads as a full output, not a full context.
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			models: [{ id: "tiny-output", maxTokens: 1 }],
		});
		const full = (text: string) => fauxAssistantMessage(text, { stopReason: "length" });
		harness.setResponses([full("a"), full("b"), fauxAssistantMessage("c")]);
		await harness.session.prompt("write");
		await harness.session.settled();
		expect(MAX_LENGTH_CONTINUATIONS).toBe(2);
		expect(harness.session.lastRunOutcome?.status).toBe("completed");
		expect(harness.getPendingResponseCount()).toBe(0);
		const users = harness.session.messages.filter((m) => m.role === "user");
		expect(users).toHaveLength(3);
		harness.cleanup();
	});
});
