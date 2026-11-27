import { describe, expect, it } from "vitest";
import {
	getGeminiMajorVersion,
	requiresToolCallId,
	supportsGoogleStrictToolSampling,
} from "../src/api/ai-sdk/google-capabilities.ts";
import { stream } from "../src/api/google-generative-ai.ts";
import type { Context, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface WirePart {
	text?: string;
	inlineData?: { data?: string };
	functionCall?: { id?: string };
	functionResponse?: { id?: string; name?: string; parts?: WirePart[]; response?: { content?: string } };
}
interface WireContent {
	role: string;
	parts?: WirePart[];
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

function makeModel<TApi extends "google-generative-ai">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id: string,
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(model: { api: string; provider: string; id: string }): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "read the files", timestamp: now },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
					{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "image.png" } },
					{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.txt" } },
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
				toolCallId: "call_a",
				toolName: "read",
				content: [{ type: "text", text: "alpha text" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_img",
				toolName: "read",
				content: [{ type: "image", data: "abc", mimeType: "image/png" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_b",
				toolName: "read",
				content: [{ type: "text", text: "beta text" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

describe("google-shared image tool result routing", () => {
	it("sends Gemini 2.x tool-result images in one turn after every function response of the model turn", async () => {
		const model = makeModel("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = await convertMessages(model, normalizeContext(makeContext(model)));

		// One user turn answers all three calls; an image turn between them would split the function responses.
		expect(contents).toHaveLength(4);
		expect(contents[2].parts).toHaveLength(3);
		expect(contents[2].parts?.every((part) => part.functionResponse)).toBe(true);
		expect(contents[2].parts?.[1]?.functionResponse?.parts).toBeUndefined();
		expect(contents[3].role).toBe("user");
		expect(contents[3].parts?.[0]?.text).toBe("Tool result image:");
		expect(contents[3].parts?.[1]?.inlineData).toBeTruthy();
	});

	it("collects images of several Gemini 2.x tool results into one turn before the next user message", async () => {
		const model = makeModel("google-generative-ai", "google", "gemini-2.5-flash");
		const context = makeContext(model);
		for (const message of context.messages) {
			if (message.role === "toolResult" && message.toolCallId === "call_b") {
				message.content = [{ type: "image", data: "def", mimeType: "image/jpeg" }];
			}
		}
		context.messages.push({ role: "user", content: "what do they show?", timestamp: Date.now() });
		const contents = await convertMessages(model, normalizeContext(context));

		expect(contents).toHaveLength(5);
		expect(contents[2].parts?.map((part) => part.functionResponse?.name)).toEqual(["read", "read", "read"]);
		expect(contents[3].parts?.map((part) => part.text ?? part.inlineData?.data)).toEqual([
			"Tool result image:",
			"abc",
			"def",
		]);
		expect(contents[4].parts?.[0]?.text).toBe("what do they show?");
	});

	it.each(["gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest", "Gemini-Flash-Latest"])(
		"treats the %s alias as Gemini 3: nested images, tool call ids and strict tool sampling",
		async (id) => {
			expect(getGeminiMajorVersion(id)).toBe(3);
			expect(requiresToolCallId(id)).toBe(true);
			expect(supportsGoogleStrictToolSampling(id)).toBe(true);

			const model = makeModel("google-generative-ai", "google", id);
			const contents = await convertMessages(model, normalizeContext(makeContext(model)));

			expect(contents).toHaveLength(3);
			expect(contents[1].parts?.map((part) => part.functionCall?.id)).toEqual(["call_a", "call_img", "call_b"]);
			expect(contents[2].parts?.map((part) => part.functionResponse?.id)).toEqual(["call_a", "call_img", "call_b"]);
			expect(contents[2].parts?.[1]?.functionResponse?.parts?.[0]?.inlineData).toBeTruthy();
		},
	);

	it("keeps other unversioned ids unknown and older Gemini versions below 3", () => {
		expect(getGeminiMajorVersion("gemini-exp-latest")).toBeUndefined();
		expect(getGeminiMajorVersion("gemini-2.5-flash")).toBe(2);
		expect(requiresToolCallId("gemini-2.5-flash")).toBe(false);
	});

	it("nests image tool results for Gemini 3 Google API models", async () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const contents = await convertMessages(model, normalizeContext(makeContext(model)));

		expect(contents).toHaveLength(3);
		const toolResultTurn = contents[2];
		expect(toolResultTurn.parts).toHaveLength(3);
		const imageResponse = toolResultTurn.parts?.[1]?.functionResponse;
		expect(imageResponse).toBeTruthy();
		expect(imageResponse?.parts).toHaveLength(1);
		expect(imageResponse?.parts?.[0]?.inlineData).toBeTruthy();
	});

	it("treats whitespace-only tool result text as no text", async () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const context = makeContext(model);
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			if (message.toolCallId === "call_a") message.content = [{ type: "text", text: "\r\n" }];
			if (message.toolCallId === "call_img") message.content.unshift({ type: "text", text: " \n" });
		}
		const contents = await convertMessages(model, normalizeContext(context));

		const responses = contents[2].parts?.map((part) => part.functionResponse?.response);
		expect(responses?.[0]?.content).toEqual("");
		expect(responses?.[1]?.content).toEqual("(see attached image)");
		expect(responses?.[2]?.content).toEqual("beta text");
	});
});
