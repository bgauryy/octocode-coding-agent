import { describe, expect, it } from "vitest";
import type { AnthropicOptions } from "../src/api/anthropic-messages/types.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model, Tool } from "../src/types.ts";
import {
	assistant,
	type Block,
	capture,
	grepTool,
	lastMarkedMessage,
	type Payload,
	systemUpdate,
	toolCall,
	toolResult,
	transcript,
	user,
	withoutMarkers,
} from "./anthropic-cache-fixtures.ts";

/**
 * Builds consecutive requests of one session through the real `stream(...onPayload)` path and checks that the bytes
 * the previous request cached (tools, system and messages up to its last history breakpoint) are an exact prefix of
 * the next request, and that the next request marks that same position so the read is an exact hit.
 */

type Turn = (model: Model<"anthropic-messages">) => Message[];

const signed = (text: string, signature: string) => ({
	type: "thinking" as const,
	thinking: text,
	thinkingSignature: signature,
});

function session(toolAddition: Tool[] | undefined): Turn[] {
	return [
		() => [user("task")],
		(model) => [
			assistant(model, [signed("plan", "sig-1"), { type: "text", text: "reading" }, toolCall("c1")]),
			toolResult("c1"),
		],
		(model) => [
			assistant(model, [toolCall("c2")]),
			toolResult("c2"),
			systemUpdate("Prefer grep for searches.", toolAddition),
		],
		(model) => [
			assistant(model, [signed("parallel", "sig-2"), toolCall("c3", "grep"), toolCall("c4")]),
			toolResult("c3", "grep"),
			toolResult("c4"),
		],
		(model) => [
			assistant(model, [
				{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
				// An aborted stream leaves thinking without a signature; it replays as text.
				{ type: "thinking", thinking: "unsigned", thinkingSignature: "" },
				{ type: "text", text: "summary" },
			]),
			user("next"),
		],
		(model) => [
			// A reply from another Claude model on the same provider: its signed thinking replays on every request alike.
			assistant(model, [signed("foreign", "sig-x"), { type: "text", text: "other model" }], {
				model: "claude-sonnet-5",
			}),
			systemUpdate("Section changed."),
			user("again"),
		],
	];
}

async function requests(
	model: Model<"anthropic-messages">,
	turns: Turn[],
	options: AnthropicOptions,
): Promise<Payload[]> {
	const payloads: Payload[] = [];
	const messages: Message[] = [];
	for (const turn of turns) {
		messages.push(...turn(model));
		payloads.push(await capture(model, transcript([...messages]), options));
	}
	return payloads;
}

/**
 * Serialized prefix without markers. String content is the API's shorthand for one text block and renders the same
 * tokens, so it is written in block form: a marked turn is sent as blocks, the same turn unmarked as a string.
 */
function serialize(payload: Payload, messages = payload.messages): string {
	const canonical = messages.map((message) =>
		typeof message.content === "string" ? { ...message, content: [{ type: "text", text: message.content }] } : message,
	);
	return JSON.stringify(withoutMarkers([payload.tools, payload.system, canonical]));
}

function cachedPrefix(payload: Payload, tail: number): string {
	return serialize(payload, payload.messages.slice(0, tail + 1));
}

function expectPrefixStable(payloads: Payload[], options: { toolsChangeAt?: number } = {}): void {
	for (let index = 1; index < payloads.length; index++) {
		const previous = payloads[index - 1];
		const next = payloads[index];
		const tail = lastMarkedMessage(previous);
		expect(tail).toBeGreaterThanOrEqual(0);
		// Parameters rendered into the prompt must not move between turns.
		expect(next.thinking).toEqual(previous.thinking);
		expect(next.output_config).toEqual(previous.output_config);
		if (options.toolsChangeAt === index) {
			// A top-level tool change invalidates everything after the tools; the system prompt still matches.
			expect(withoutMarkers(next.tools)).not.toEqual(withoutMarkers(previous.tools));
			expect(withoutMarkers(next.system)).toEqual(withoutMarkers(previous.system));
			continue;
		}
		const before = cachedPrefix(previous, tail);
		// Byte prefix: drop the closing brackets of the message list and the outer array.
		expect(serialize(next).startsWith(before.slice(0, -2))).toBe(true);
		expect(cachedPrefix(next, tail)).toBe(before);
		// The previous write position carries a marker again, so the read hits it exactly.
		const previousTail = previous.messages[tail].content as Block[];
		const nextTail = next.messages[tail].content as Block[];
		expect(nextTail.at(-1)?.cache_control).toEqual(previousTail.at(-1)?.cache_control);
	}
}

const assistantBlocks = (payload: Payload) =>
	payload.messages.filter((message) => message.role === "assistant").map((message) => message.content as Block[]);

describe("Anthropic cached prefix stability across requests", () => {
	it("native mid-conversation model keeps tools, system and history through a tool addition", async () => {
		const model = getBuiltinModel("anthropic", "claude-opus-5-5");
		const payloads = await requests(model, session([grepTool]), {});
		expectPrefixStable(payloads);

		const last = payloads.at(-1)!;
		expect(last.tools?.map((tool) => tool.name)).toEqual(["read", "__octocode_deferred_placeholder__"]);
		expect(last.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		const [first, , third, fourth, foreign] = assistantBlocks(last);
		expect(first[0]).toEqual({ type: "thinking", thinking: "plan", signature: "sig-1" });
		expect(third[0]).toEqual({ type: "thinking", thinking: "parallel", signature: "sig-2" });
		expect(fourth.slice(0, 2)).toEqual([
			{ type: "redacted_thinking", data: "opaque" },
			{ type: "text", text: "unsigned" },
		]);
		expect(foreign).toEqual([
			{ type: "thinking", thinking: "foreign", signature: "sig-x" },
			{ type: "text", text: "other model" },
		]);
	});

	it("budget-thinking collapse-path model keeps system and history through a text update", async () => {
		const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const options = { thinkingEnabled: true, thinkingBudgetTokens: 2048 };
		const payloads = await requests(model, session(undefined), options);
		expectPrefixStable(payloads);
		expect(payloads.at(-1)?.thinking).toEqual({ type: "enabled", budget_tokens: 2048, display: "summarized" });
		// Later system updates travel as user text; the top-level system prompt never changes.
		expect(payloads.at(-1)?.messages.some((message) => message.role === "system")).toBe(false);
	});

	it("adaptive collapse-path model (Sonnet 5) keeps the prefix, and a tool addition only changes the tools", async () => {
		const model = getBuiltinModel("anthropic", "claude-sonnet-5");
		const options = { thinkingEnabled: true, effort: "medium" as const };
		expectPrefixStable(await requests(model, session(undefined), options));
		expectPrefixStable(await requests(model, session([grepTool]), options), { toolsChangeAt: 2 });
	});

	it("an effort change on a managed-effort model only adds a marker after the cached tail", async () => {
		const model = getBuiltinModel("anthropic", "claude-opus-5-5");
		const history = session(undefined).slice(0, 2);
		const messages = history.flatMap((turn) => turn(model));
		const high = await capture(model, transcript(messages), { effort: "high" });
		const low = await capture(model, transcript(messages), { effort: "low" });
		const tail = lastMarkedMessage(high);
		expect(cachedPrefix(low, tail)).toBe(cachedPrefix(high, tail));
		expect(low.output_config).toEqual(high.output_config);
		expect(low.messages.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
	});

	it("an aborted empty reply between requests leaves the cached prefix intact", async () => {
		const model = getBuiltinModel("anthropic", "claude-opus-5-5");
		const base = [user("task")];
		const empty: AssistantMessage = { ...assistant(model, []), stopReason: "aborted" };
		const before = await capture(model, transcript(base));
		const after = await capture(model, transcript([...base, empty, user("retry")]));
		const tail = lastMarkedMessage(before);
		expect(cachedPrefix(after, tail)).toBe(cachedPrefix(before, tail));
	});

	it("skips a redacted thinking block that has no payload to replay", async () => {
		const model = getBuiltinModel("anthropic", "claude-opus-5-5");
		const reply = assistant(model, [
			{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true },
			{ type: "text", text: "answer" },
		]);
		const payload = await capture(model, transcript([user("task"), reply, user("next")]));
		expect(assistantBlocks(payload)).toEqual([[{ type: "text", text: "answer" }]]);
	});
});
