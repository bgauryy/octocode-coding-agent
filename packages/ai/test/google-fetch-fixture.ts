import { stream } from "../src/api/google-generative-ai.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

export interface GoogleWireConfig {
	temperature?: number;
	maxOutputTokens?: number;
	thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number };
}
export interface GoogleWirePayload {
	generationConfig?: GoogleWireConfig;
	config?: GoogleWireConfig;
}

export const googleModel: Model<"google-generative-ai"> = {
	id: "gemini-2.5-flash",
	name: "Gemini",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};
export const googleContext = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
export function googleFrames(chunks: unknown[]) {
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
export interface GoogleWireTools {
	functionDeclarations: { name: string; parametersJsonSchema: Record<string, unknown> }[];
}
export async function googleToolWire(tools: Tool[], id = "gemini-3-flash-preview") {
	let captured: GoogleWireTools[] | undefined;
	const result = await stream(
		{ ...googleModel, id },
		normalizeContext({
			messages: [
				{ role: "system", content: "", toolsAdded: tools, timestamp: 0 },
				{ role: "user", content: "Hi", timestamp: 0 },
			],
		}),
		{
			apiKey: "test-key",
			onPayload: (body) => {
				captured = (body as { tools?: GoogleWireTools[] }).tools;
				throw new Error("request captured");
			},
		},
	).result();
	if (result.errorMessage !== "request captured") throw new Error(result.errorMessage);
	return captured;
}
export async function googleUsage(usageMetadata: Record<string, number>) {
	const result = await stream(googleModel, googleContext, {
		apiKey: "test-key",
		fetch: async () =>
			googleFrames([
				{
					candidates: [{ index: 0, content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }],
					usageMetadata,
				},
			]),
	}).result();
	if (result.stopReason !== "stop") throw new Error(result.errorMessage);
	return result.usage;
}
