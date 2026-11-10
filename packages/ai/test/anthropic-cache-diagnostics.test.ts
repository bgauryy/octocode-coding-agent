import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheMissDiagnostic } from "../src/api/anthropic-messages/cache-diagnostics.ts";
import { handleAnthropicStreamEvent } from "../src/api/anthropic-messages/stream-events.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import {
	assistant,
	capture,
	type Payload,
	toolResult,
	toolCall,
	transcript,
	user,
} from "./anthropic-cache-fixtures.ts";

const model = getBuiltinModel("anthropic", "claude-opus-5-5");
const on = { env: { OCTOCODE_CACHE_DIAGNOSTICS: "on" } };

const diagnostics = (payload: Payload) => (payload as Payload & { diagnostics?: unknown }).diagnostics;
const reply = (id: string | undefined, target: Model<"anthropic-messages"> = model) => ({
	...assistant(target, [toolCall("c1")]),
	...(id ? { responseId: id } : {}),
});

describe("Anthropic cache diagnostics request field", () => {
	beforeEach(() => {
		// The variable is read from the process when a request passes no env; start from a known state.
		vi.stubEnv("OCTOCODE_CACHE_DIAGNOSTICS", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("is not sent unless enabled", async () => {
		const payload = await capture(model, transcript([user("task")]));
		expect("diagnostics" in payload).toBe(false);
	});

	it("opts in with a null previous id on the first request", async () => {
		const payload = await capture(model, transcript([user("task")]), on);
		expect(diagnostics(payload)).toEqual({ previous_message_id: null });
	});

	it("names the latest assistant response of the conversation", async () => {
		const messages = [
			user("task"),
			reply("msg_first"),
			toolResult("c1"),
			{ ...reply("msg_second"), content: [toolCall("c2")] },
			toolResult("c2"),
		];
		const payload = await capture(model, transcript(messages), on);
		expect(diagnostics(payload)).toEqual({ previous_message_id: "msg_second" });
	});

	it("ignores replies that carry no Anthropic message id", async () => {
		const payload = await capture(model, transcript([user("task"), reply("resp_abc"), toolResult("c1")]), on);
		expect(diagnostics(payload)).toEqual({ previous_message_id: null });
	});

	it("accepts the other truthy spellings and ignores anything else", async () => {
		for (const value of ["1", "true", "ON"]) {
			const payload = await capture(model, transcript([user("task")]), { env: { OCTOCODE_CACHE_DIAGNOSTICS: value } });
			expect(diagnostics(payload)).toEqual({ previous_message_id: null });
		}
		const off = await capture(model, transcript([user("task")]), { env: { OCTOCODE_CACHE_DIAGNOSTICS: "off" } });
		expect("diagnostics" in off).toBe(false);
	});

	it("is never sent to a gateway, whose body validation may reject the field", async () => {
		const gateway: Model<"anthropic-messages"> = { ...model, baseUrl: "https://gateway.example.com" };
		const payload = await capture(gateway, transcript([user("task")]), on);
		expect("diagnostics" in payload).toBe(false);
	});

	it("is never sent to another provider that speaks the Anthropic API", async () => {
		const other: Model<"anthropic-messages"> = { ...model, provider: "opencode" };
		const payload = await capture(other, transcript([user("task")]), on);
		expect("diagnostics" in payload).toBe(false);
	});

	it("does not change cache markers or the cached prefix", async () => {
		const messages = [user("task"), reply("msg_first"), toolResult("c1")];
		const plain = await capture(model, transcript(messages));
		const probed = await capture(model, transcript(messages), on);
		expect({ ...probed, diagnostics: undefined }).toEqual({ ...plain, diagnostics: undefined });
	});
});

describe("Anthropic cache miss reason", () => {
	it.each([
		[
			{ type: "system_changed", cache_missed_input_tokens: 41850 },
			{ reason: "system_changed", missedInputTokens: 41850 },
		],
		[
			{ type: "tools_changed", cache_missed_input_tokens: 7 },
			{ reason: "tools_changed", missedInputTokens: 7 },
		],
		[{ type: "model_changed" }, { reason: "model_changed" }],
	] as const)("records %j", (reason, details) => {
		expect(cacheMissDiagnostic({ cache_miss_reason: reason as never }, 5)).toEqual({
			type: "cache_miss",
			timestamp: 5,
			details,
		});
	});

	it("records nothing when there is no divergence, the comparison is pending, or none was possible", () => {
		expect(cacheMissDiagnostic(null)).toBeUndefined();
		expect(cacheMissDiagnostic(undefined)).toBeUndefined();
		expect(cacheMissDiagnostic({ cache_miss_reason: null })).toBeUndefined();
		expect(cacheMissDiagnostic({ cache_miss_reason: { type: "unavailable" } })).toBeUndefined();
		expect(cacheMissDiagnostic({ cache_miss_reason: { type: "previous_message_not_found" } })).toBeUndefined();
	});

	it("lands on the assistant message from message_start", () => {
		const output = createPendingAssistantMessage(model);
		const start = (diagnosticsValue: unknown) =>
			({
				type: "message_start",
				message: {
					id: "msg_now",
					model: model.id,
					diagnostics: diagnosticsValue,
					usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 9 },
				},
			}) as never;
		const state = {
			model,
			output,
			stream: new AssistantMessageEventStream(),
			isOAuth: false,
			currentTools: [],
			usageModel: model,
			inputTransformations: undefined,
		};
		handleAnthropicStreamEvent(start(null), state);
		expect(output.diagnostics).toBeUndefined();
		handleAnthropicStreamEvent(
			start({ cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 1234 } }),
			state,
		);
		expect(output.responseId).toBe("msg_now");
		expect(output.diagnostics).toMatchObject([
			{ type: "cache_miss", details: { reason: "messages_changed", missedInputTokens: 1234 } },
		]);
	});
});
