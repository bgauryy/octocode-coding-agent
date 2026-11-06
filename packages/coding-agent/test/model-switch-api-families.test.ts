// B154 gap 4: `/model` across API families inside one session. Two faux providers with different `api` ids stand in for
// two provider families; the session switches between them mid-conversation and the next request must still carry the
// whole transcript (text and a tool call with its result), and each family's adapter must answer from its own script.
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { registerFauxProvider } from "@octocodeai/octocode-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.ts";

const echo: AgentTool = {
	name: "echo",
	label: "echo",
	description: "Returns its text",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `echoed ${(params as { text: string }).text}` }],
		details: {},
	}),
};

const textOf = (context: TranscriptContext): string =>
	JSON.stringify(
		context.messages.map((message) => ({ role: message.role, content: (message as { content: unknown }).content })),
	);

describe("/model across API families", () => {
	const harnesses: Harness[] = [];
	const unregister: Array<() => void> = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (unregister.length > 0) unregister.pop()?.();
	});

	async function start() {
		const harness = await createHarness({ tools: [echo], models: [{ id: "alpha-1" }] });
		harnesses.push(harness);
		const other = registerFauxProvider({ provider: "faux-other", api: "faux-other-api", models: [{ id: "beta-1" }] });
		unregister.push(other.unregister);
		const model = other.getModel();
		harness.session.modelRuntime.registerProvider("faux-other", {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: other.api,
			models: other.models.map((each) => ({
				id: each.id,
				name: each.name,
				api: each.api,
				reasoning: each.reasoning,
				input: each.input,
				cost: each.cost,
				contextWindow: each.contextWindow,
				maxTokens: each.maxTokens,
				baseUrl: each.baseUrl,
			})),
		});
		return { harness, other, model };
	}

	/** A scripted step that records the transcript it was asked to answer, then replies. */
	const recording = (seen: string[], reply: AssistantMessage): FauxResponseStep => {
		return (context) => {
			seen.push(textOf(context));
			return reply;
		};
	};

	it("keeps the conversation, tool call and tool result usable on the other family, and back again", async () => {
		const { harness, other, model } = await start();
		expect(model.api).not.toBe(harness.getModel().api);
		const seenByAlpha: string[] = [];
		const seenByBeta: string[] = [];

		// Family one: a turn with a tool call.
		harness.setResponses([
			recording(
				seenByAlpha,
				fauxAssistantMessage([fauxToolCall("echo", { text: "first" })], { stopReason: "toolUse" }),
			),
			recording(seenByAlpha, fauxAssistantMessage("alpha answered")),
		]);
		await harness.session.prompt("question one");
		expect(getAssistantTexts(harness)).toContain("alpha answered");

		// `/model` to the other family: the next request goes to its adapter with the earlier transcript.
		await harness.session.setModel(model);
		expect(harness.session.model?.api).toBe("faux-other-api");
		other.setResponses([recording(seenByBeta, fauxAssistantMessage("beta answered"))]);
		await harness.session.prompt("question two");
		expect(seenByBeta).toHaveLength(1);
		for (const expected of ["question one", "echoed first", "alpha answered", "question two"])
			expect(seenByBeta[0]).toContain(expected);
		expect(getAssistantTexts(harness)).toContain("beta answered");
		// Family one never saw the second turn.
		expect(seenByAlpha).toHaveLength(2);

		// And back: family one gets the whole conversation, including the other family's answer.
		await harness.session.setModel(harness.getModel());
		expect(harness.session.model?.api).toBe(harness.getModel().api);
		harness.setResponses([recording(seenByAlpha, fauxAssistantMessage("alpha again"))]);
		await harness.session.prompt("question three");
		expect(seenByAlpha).toHaveLength(3);
		for (const expected of ["question one", "question two", "beta answered", "question three"])
			expect(seenByAlpha[2]).toContain(expected);
		expect(getAssistantTexts(harness)).toEqual(["", "alpha answered", "beta answered", "alpha again"]);
	});

	it("records each assistant message under the family that produced it", async () => {
		const { harness, other, model } = await start();
		harness.setResponses([fauxAssistantMessage("from alpha")]);
		await harness.session.prompt("one");
		await harness.session.setModel(model);
		other.setResponses([fauxAssistantMessage("from beta")]);
		await harness.session.prompt("two");

		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants.map((message) => [message.provider, message.api])).toEqual([
			[harness.getModel().provider, harness.getModel().api],
			["faux-other", "faux-other-api"],
		]);
	});
});
