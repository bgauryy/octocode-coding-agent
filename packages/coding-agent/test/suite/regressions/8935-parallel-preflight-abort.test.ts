import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("#8935 parallel preflight abort", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each(["shared", "exclusive"] as const)("aborts queued and later tools with %s scheduling", async (concurrency) => {
		const executions: string[] = [];
		const preflights: string[] = [];
		const resultHooks: string[] = [];
		const release = Promise.withResolvers<void>();
		const externalWrite: AgentTool = {
			name: "external_write",
			label: "External write",
			description: "Perform an external write",
			parameters: Type.Object({ value: Type.String() }),
			concurrency,
			execute: async (_toolCallId, params) => {
				const value = typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				executions.push(value);
				if (concurrency === "exclusive" && value === "first") await release.promise;
				return { content: [{ type: "text", text: value }], details: { value } };
			},
		};
		const harness = await createHarness({
			tools: [externalWrite],
			extensionFactories: [
				(api) => {
					api.on("tool_call", async (event, ctx) => {
						const value = "value" in event.input ? String(event.input.value) : "";
						preflights.push(value);
						if (value === "second") {
							ctx.abort();
							release.resolve();
						}
					});
					api.on("tool_result", async (event) => {
						resultHooks.push(event.toolCallId);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				["first", "queued", "second", "later"].map((value) => fauxToolCall("external_write", { value })),
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.prompt("run both writes");

		expect(preflights).toEqual(["first", "queued", "second"]);
		// Shared calls already approved may finish while a later approval is pending.
		// An exclusive call still queued when abort arrives must never execute.
		const completed = concurrency === "shared" ? ["first", "queued"] : ["first"];
		expect(executions).toEqual(completed);

		const starts = harness.eventsOfType("tool_execution_start");
		const ends = harness.eventsOfType("tool_execution_end");
		expect(starts).toHaveLength(4);
		expect(ends).toHaveLength(4);
		expect(new Set(ends.map((event) => event.toolCallId))).toEqual(new Set(starts.map((event) => event.toolCallId)));
		expect(resultHooks).toEqual(starts.slice(0, completed.length).map((event) => event.toolCallId));
		for (const start of starts) {
			expect(ends.find((event) => event.toolCallId === start.toolCallId)?.isError).toBe(
				!completed.includes(String(start.args.value)),
			);
		}

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((message) => message.toolCallId)).toEqual(starts.map((event) => event.toolCallId));
		expect(toolResults.map(getMessageText)).toEqual(
			["first", "queued", "second", "later"].map((value) => (completed.includes(value) ? value : "Operation aborted")),
		);
	});
});
