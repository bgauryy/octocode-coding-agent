import { describe, expect, it } from "vitest";
import { requiresToolCallId } from "../src/api/ai-sdk/google-capabilities.ts";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as vertex } from "../src/api/google-vertex.ts";
import type { Context, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface WirePart {
	text?: string;
	thoughtSignature?: string;
	functionCall?: { id?: string };
	functionResponse?: { id?: string };
}
interface WireContent {
	role: string;
	parts?: WirePart[];
}
async function convertMessages(
	model: Model<"google-generative-ai" | "google-vertex">,
	context: TranscriptContext,
): Promise<WireContent[]> {
	let contents: WireContent[] | undefined;
	const options = {
		apiKey: "test-key",
		project: "test-project",
		location: "us-central1",
		onPayload: (payload: unknown) => {
			contents = (payload as { contents: WireContent[] }).contents;
			throw new Error("request captured");
		},
	};
	const result = await (
		model.api === "google-vertex"
			? vertex(model as Model<"google-vertex">, context, options)
			: google(model as Model<"google-generative-ai">, context, options)
	).result();
	expect(result.errorMessage).toBe("request captured");
	if (!contents) throw new Error("No request captured");
	return contents;
}

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(model: { api: string; provider: string; id: string }, thoughtSignature?: string): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "echo hi" },
						...(thoughtSignature && { thoughtSignature }),
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "bash",
						arguments: { command: "ls -la" },
					},
				],
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
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "files" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it.each([
		makeGemini3Model("google-generative-ai", "google"),
		makeGemini3Model("google-generative-ai", "google", "gemini-3.6-flash"),
		makeGemini3Model("google-vertex", "google-vertex"),
	])("preserves tool call IDs for $id via $api history", async (model) => {
		const context = makeContext(model);
		const contents = await convertMessages(model, normalizeContext(context));
		const functionCallIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : []));
		const functionResponseIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionResponse?.id ? [part.functionResponse.id] : []));

		expect(functionCallIds).toEqual(["call_1", "call_2"]);
		expect(functionResponseIds).toEqual(["call_1", "call_2"]);
	});

	it("uses the documented skip_thought_signature_validator for unsigned Google Gen AI tool calls", async () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = await convertMessages(model, normalizeContext(makeContext({ ...model, id: "other-model" })));

		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn).toBeTruthy();

		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];
		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe("skip_thought_signature_validator");
		expect(functionCallParts[1]?.thoughtSignature).toBe("skip_thought_signature_validator");
		expect(
			(modelTurn?.parts ?? [])
				.filter((part) => part.thoughtSignature === "skip_thought_signature_validator")
				.every((part) => part.functionCall !== undefined),
		).toBe(true);

		const textParts = modelTurn?.parts?.filter((p) => p.text !== undefined) ?? [];
		const historicalText = textParts.filter((p) => p.text?.includes("Historical context"));
		expect(historicalText).toHaveLength(0);
	});

	it("uses the documented skip_thought_signature_validator for unsigned Vertex tool calls", async () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = await convertMessages(model, normalizeContext(makeContext(model)));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe("skip_thought_signature_validator");
		expect(functionCallParts[1]?.thoughtSignature).toBe("skip_thought_signature_validator");
		expect(
			(modelTurn?.parts ?? [])
				.filter((part) => part.thoughtSignature === "skip_thought_signature_validator")
				.every((part) => part.functionCall !== undefined),
		).toBe(true);
	});

	it("preserves valid thoughtSignature when present for the same provider and model", async () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const contents = await convertMessages(model, normalizeContext(makeContext(model, validSig)));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe(validSig);
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
	});

	it("does not add a thoughtSignature for non-Gemini-3 models", async () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = await convertMessages(model, normalizeContext(makeContext({ ...model, id: "other-model" })));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((part) => part.functionCall !== undefined) ?? [];
		const functionResponseParts = contents
			.flatMap((content) => content.parts ?? [])
			.filter((part) => part.functionResponse !== undefined);

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts.every((part) => part.functionCall?.id === undefined)).toBe(true);
		expect(functionCallParts.every((part) => part.thoughtSignature === undefined)).toBe(true);
		expect(functionResponseParts).toHaveLength(2);
		expect(functionResponseParts.every((part) => part.functionResponse?.id === undefined)).toBe(true);
	});
});

describe("requiresToolCallId", () => {
	it.each([
		[false, "gemini-2.5-flash"],
		[true, "gemini-3.6-flash"],
		[true, "claude-sonnet-4-5"],
		[true, "gpt-oss-120b"],
	] as const)("returns %s for %s", (expected, modelId) => {
		expect(requiresToolCallId(modelId)).toBe(expected);
	});
});
