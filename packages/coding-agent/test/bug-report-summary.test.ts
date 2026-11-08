import { contentText, fauxAssistantMessage, getCurrentSystemMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { generateBugReportSummary } from "../src/core/bug-report.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness;
afterEach(() => harness?.cleanup());

it("requests a tool-free factual report without changing the session transcript", async () => {
	harness = await createHarness();
	harness.setResponses([fauxAssistantMessage("## What went wrong\nThe terminal froze.")]);
	const streamFn = vi.fn(harness.session.agent.streamFunction);
	const entries = structuredClone(harness.sessionManager.getEntries());
	const summary = await generateBugReportSummary({
		model: harness.session.model!,
		messages: [{ role: "user", content: "The terminal froze after /model.", timestamp: 1 }],
		hint: "Switching models hangs",
		signal: new AbortController().signal,
		streamFn,
	});
	expect(summary).toContain("The terminal froze.");
	expect(streamFn).toHaveBeenCalledOnce();
	const context = streamFn.mock.calls[0][1];
	expect(getCurrentTools(context.messages)).toEqual([]);
	const system = contentText(getCurrentSystemMessage(context.messages)!.content);
	expect(system).toContain("Never invent a reproduction");
	expect(system).toContain("Reproduce no secrets or credentials");
	const request = contentText(context.messages.findLast((message) => message.role === "user")!.content);
	expect(request).toContain("The terminal froze after /model.");
	expect(request).toContain("Switching models hangs");
	expect(request).toContain("## Steps to reproduce");
	expect(harness.sessionManager.getEntries()).toEqual(entries);
});

it.each([
	["empty", fauxAssistantMessage(" "), "empty"],
	["aborted", { ...fauxAssistantMessage("partial"), stopReason: "aborted" as const }, "cancelled"],
	["truncated", { ...fauxAssistantMessage("partial"), stopReason: "length" as const }, "incomplete"],
	[
		"tool call",
		{
			...fauxAssistantMessage(""),
			stopReason: "toolUse" as const,
			content: [{ type: "toolCall" as const, id: "bad", name: "execute", arguments: {} }],
		},
		"tool",
	],
])("rejects a %s report without submitting it", async (_label, response, expected) => {
	harness = await createHarness();
	harness.setResponses([response]);
	await expect(
		generateBugReportSummary({
			model: harness.session.model!,
			messages: [],
			signal: new AbortController().signal,
			streamFn: harness.session.agent.streamFunction,
		}),
	).rejects.toThrow(expected);
});
