import { describe, expect, it } from "vitest";
import { anthropicSdkMessages } from "../src/api/ai-sdk/anthropic-messages.ts";
import { fauxAssistantMessage, fauxThinking } from "../src/providers/faux.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = getBuiltinModel("anthropic", "claude-sonnet-4-6");

const reply = (message: AssistantMessage): AssistantMessage => ({
	...message,
	api: model.api,
	provider: model.provider,
	model: model.id,
});

describe("Anthropic system updates", () => {
	it.each([
		["an empty reply", fauxAssistantMessage("")],
		["another model's reasoning-only reply", fauxAssistantMessage([fauxThinking("")])],
	])("are sent before the next assistant message when %s converts to nothing", (_name, empty) => {
		const messages: Message[] = [
			{ role: "system", content: "base prompt", timestamp: 0 },
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "system", content: "update", timestamp: 2 },
			empty,
			{ role: "user", content: "second", timestamp: 4 },
			reply(fauxAssistantMessage("answer")),
			{ role: "user", content: "third", timestamp: 6 },
		];
		const sent = anthropicSdkMessages(model, normalizeContext({ messages }), {}, false);
		const roles = sent.map((message) => message.role);
		expect(roles).toEqual(["system", "user", "user", "system", "assistant", "user"]);
		expect(sent[3]).toMatchObject({ role: "system", content: "update" });
	});
});
