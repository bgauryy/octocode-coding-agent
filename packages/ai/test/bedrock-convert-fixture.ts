import { stream } from "../src/api/bedrock-converse-stream.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";
export const bedrockMock = { streamEvents: undefined as Record<string, unknown>[] | undefined };
export const streamBedrock: typeof stream = (model, context, options) =>
	stream(model, context, {
		apiKey: "test",
		env: {},
		...options,
		fetch: async () => bedrockResponse(bedrockMock.streamEvents ?? bedrockTextEvents),
	});
export const baseModel: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5 (US)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
	compat: { supportsStrictMode: true },
};
export const novaModel: Model<"bedrock-converse-stream"> = {
	...baseModel,
	id: "amazon.nova-lite-v1:0",
	name: "Nova Lite",
	reasoning: false,
	compat: undefined,
};
export async function capturePayload(context: Context, model = baseModel): Promise<unknown> {
	let capturedPayload: unknown;
	await streamBedrock(model, normalizeContext(context), {
		cacheRetention: "none",
		onPayload: (payload) => {
			capturedPayload = payload;
			return payload;
		},
	}).result();
	return capturedPayload;
}
