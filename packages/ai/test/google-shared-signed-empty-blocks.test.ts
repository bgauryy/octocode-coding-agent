import { describe, expect, it } from "vitest";
import { stream } from "../src/api/google-generative-ai.ts";
import type { AssistantMessage, Context, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Gemini can attach `thoughtSignature` to a response part whose visible text is empty (e.g. a
// thought burst preceding a function call) and requires the signature echoed back on the next
// request. Dropping such blocks while rebuilding history silently breaks the reasoning chain:
// the model then intermittently ends a mid-task turn with a thought-only STOP and no tool call.
// These tests pin the rule: an empty text/thinking block is skipped only when it is UNSIGNED.

function makeModel(id = "gemini-3-pro-preview"): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const VALID_SIG = "AAAAAAAAAAAAAAAAAAAAAA==";

interface WireContent {
	role: string;
	parts?: { thoughtSignature?: string; thought?: boolean; functionCall?: unknown }[];
}
async function convertMessages(
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
): Promise<WireContent[]> {
	let contents: WireContent[] | undefined;
	const result = await stream(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			contents = (payload as { contents: WireContent[] }).contents;
			throw new Error("request captured");
		},
	}).result();
	expect(result.errorMessage).toBe("request captured");
	if (!contents) throw new Error("No request captured");
	return contents;
}

function makeContext(
	model: { api: string; provider: string; id: string },
	content: AssistantMessage["content"],
): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: now,
			},
		],
	};
}

describe("Google SDK replay — signed empty blocks", () => {
	it("keeps a signed empty thinking block so its signature is echoed back", async () => {
		const model = makeModel();
		const contents = await convertMessages(
			model,
			normalizeContext(
				makeContext(model, [
					{ type: "thinking", thinking: "", thinkingSignature: VALID_SIG },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		const signed = modelTurn?.parts?.filter((p) => p.thoughtSignature === VALID_SIG) ?? [];
		expect(signed).toHaveLength(1);
		expect(signed[0]?.thought).toBe(true);
	});

	it("keeps a signed empty text block the same way", async () => {
		const model = makeModel();
		const contents = await convertMessages(
			model,
			normalizeContext(
				makeContext(model, [
					{ type: "text", text: "", textSignature: VALID_SIG },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		const signed = modelTurn?.parts?.filter((p) => p.thoughtSignature === VALID_SIG) ?? [];
		expect(signed).toHaveLength(1);
	});

	it("still drops unsigned empty blocks", async () => {
		const model = makeModel();
		const contents = await convertMessages(
			model,
			normalizeContext(
				makeContext(model, [
					{ type: "thinking", thinking: "" },
					{ type: "text", text: "   " },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn?.parts).toHaveLength(1);
		expect(modelTurn?.parts?.[0]?.functionCall).toBeTruthy();
	});

	it("still drops signed empty blocks from a different provider/model (signature unusable)", async () => {
		const model = makeModel();
		const contents = await convertMessages(
			model,
			normalizeContext(
				makeContext({ ...model, id: "other-model" }, [
					{ type: "thinking", thinking: "", thinkingSignature: VALID_SIG },
					{ type: "text", text: "", textSignature: VALID_SIG },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn?.parts).toHaveLength(1);
		expect(modelTurn?.parts?.[0]?.functionCall).toBeTruthy();
		expect(JSON.stringify(modelTurn)).not.toContain(VALID_SIG);
	});
});
