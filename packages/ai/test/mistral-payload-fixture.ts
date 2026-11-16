import { stream } from "../src/api/mistral-conversations.ts";
import type { MistralOptions } from "../src/api/mistral-conversations/types.ts";
import type { Model, TranscriptContext } from "../src/types.ts";

export async function captureMistralPayload(
	model: Model<"mistral-conversations">,
	context: TranscriptContext,
	options: MistralOptions = {},
) {
	let captured: unknown;
	await stream(model, context, {
		...options,
		apiKey: "fixture",
		onPayload: (body) => {
			captured = body;
			throw new Error("payload captured");
		},
	}).result();
	if (!captured) throw new Error("Mistral payload was not captured");
	return captured as {
		temperature?: number;
		tools?: { function: { strict?: boolean } }[];
		messages: { role: string; content: unknown }[];
	};
}
