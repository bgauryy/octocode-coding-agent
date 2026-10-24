import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Message, Model, StreamOptions } from "../src/types.ts";
import {
	assistant,
	capture,
	grepTool,
	markers,
	PNG,
	type Payload,
	readTool,
	systemUpdate,
	toolCall,
	toolResult,
	transcript,
	user,
} from "./anthropic-cache-fixtures.ts";

/**
 * Table-driven check of Anthropic cache breakpoint placement: at most four markers, a longer TTL never after a
 * shorter one in prefix order (tools, system, messages), markers only on blocks that can carry one, and the history
 * lookback marker present whenever a previous request's tail exists.
 */

const collapse = getBuiltinModel("anthropic", "claude-haiku-4-5");
const native = getBuiltinModel("anthropic", "claude-opus-5-5");

type History = { name: string; messages: (model: Model<"anthropic-messages">) => Message[]; history: number };
const histories: History[] = [
	{ name: "single user turn", messages: () => [user("task")], history: 1 },
	{
		name: "tool turn",
		messages: (model) => [user("task"), assistant(model, [toolCall("c1")]), toolResult("c1")],
		history: 2,
	},
	{
		name: "system update with a tool addition",
		messages: (model) => [
			user("task"),
			assistant(model, [toolCall("c1")]),
			toolResult("c1"),
			systemUpdate("Use grep for searches.", [grepTool]),
			assistant(model, [toolCall("c2", "grep")]),
			toolResult("c2", "grep"),
		],
		history: 2,
	},
	{
		name: "system update as the tail",
		messages: (model) => [
			user("task"),
			assistant(model, [{ type: "text", text: "done" }]),
			systemUpdate("New section."),
		],
		history: 2,
	},
	{
		name: "image-only tail",
		messages: (model) => [
			user("task"),
			assistant(model, [{ type: "text", text: "send it" }]),
			user([{ type: "image", data: PNG, mimeType: "image/png" }]),
		],
		history: 2,
	},
	{
		name: "error tool result with an image",
		messages: (model) => [
			user("task"),
			assistant(model, [toolCall("c1")]),
			{
				...toolResult("c1"),
				isError: true,
				content: [
					{ type: "text", text: "failed" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				],
			},
		],
		history: 2,
	},
	{
		// The whitespace turn is dropped, so the request ends with the assistant and has no history tail to mark.
		name: "whitespace-only tail",
		messages: (model) => [user("task"), assistant(model, [{ type: "text", text: "reply" }]), user("   ")],
		history: 0,
	},
];

const retentions: { name: string; options: StreamOptions; instructionTtl?: string; historyTtl?: string }[] = [
	{ name: "short", options: { cacheRetention: "short" } },
	{ name: "long", options: { cacheRetention: "long" }, instructionTtl: "1h", historyTtl: "1h" },
	{
		name: "long instructions, short history",
		options: { cacheRetention: "short", instructionCacheRetention: "long" },
		instructionTtl: "1h",
	},
];

const cases = [collapse, native].flatMap((model) =>
	["sk-ant-api-test", "sk-ant-oat01-test"].flatMap((apiKey) =>
		[undefined, "project_context"].flatMap((boundary) =>
			retentions.flatMap((retention) => histories.map((history) => ({ model, apiKey, boundary, retention, history }))),
		),
	),
);

const rank = (ttl: string | undefined) => (ttl === "1h" ? 2 : 1);

function expectValidPlacement(payload: Payload): void {
	const found = markers(payload);
	expect(found.length).toBeLessThanOrEqual(4);
	const ranks = found.map(({ block }) => rank(block.cache_control?.ttl));
	for (let index = 1; index < ranks.length; index++) expect(ranks[index]).toBeLessThanOrEqual(ranks[index - 1]);
	for (const { block, section } of found) {
		if (section === "tools") continue;
		expect(["text", "image", "tool_result", "tool_addition", "tool_removal"]).toContain(block.type);
		if (block.type === "text") expect(block.text?.trim()).not.toBe("");
	}
	// The API rejects whitespace-only text anywhere, marked or not.
	for (const message of payload.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) if (block.type === "text") expect(block.text?.trim()).not.toBe("");
	}
}

describe("Anthropic cache breakpoint matrix", () => {
	it.each(cases)(
		"$model.id key=$apiKey boundary=$boundary retention=$retention.name: $history.name",
		async ({ model, apiKey, boundary, retention, history }) => {
			const payload = await capture(model, transcript(history.messages(model)), {
				apiKey,
				instructionCacheBoundary: boundary,
				...retention.options,
			});
			expectValidPlacement(payload);

			const found = markers(payload);
			const instructions = found.filter(({ section }) => section !== "messages");
			const historyMarkers = found.filter(({ section }) => section === "messages");
			// Split: base and project blocks. Unsplit: the prompt block and the last initial tool.
			expect(instructions).toHaveLength(2);
			expect(historyMarkers).toHaveLength(history.history);
			for (const { block } of instructions) expect(block.cache_control?.ttl).toBe(retention.instructionTtl);
			for (const { block } of historyMarkers) expect(block.cache_control?.ttl).toBe(retention.historyTtl);
			if (boundary) expect(found.filter(({ section }) => section === "system")).toHaveLength(2);
			// OAuth: the identity block precedes the prompt and stays unmarked.
			if (apiKey.includes("oat")) expect(payload.system?.[0].cache_control).toBeUndefined();
		},
	);

	it("keeps native tool changes off the top-level tool list", async () => {
		const history = histories[2];
		const payload = await capture(native, transcript(history.messages(native)));
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["read", "__pi_deferred_placeholder__"]);
		expect(payload.tools?.[0].cache_control).toBeDefined();
		expect(payload.tools?.[1].cache_control).toBeUndefined();
		const updates = payload.messages.filter((message) => message.role === "system" && message.content.length > 0);
		expect(updates.flatMap((message) => (message.content as { type: string }[]).map((block) => block.type))).toEqual([
			"text",
			"tool_addition",
		]);
	});

	it("drops a whitespace-only mid-conversation system update instead of sending an empty text block", async () => {
		const messages = [
			user("task"),
			assistant(native, [{ type: "text", text: "done" }]),
			user("next"),
			systemUpdate("   \n"),
		];
		const payload = await capture(native, transcript(messages));
		expectValidPlacement(payload);
		expect(payload.messages.filter((message) => message.role === "system" && message.content.length > 0)).toEqual([]);
		// The last user turn becomes the tail, and the first one the lookback anchor.
		expect(markers(payload).filter(({ section }) => section === "messages")).toHaveLength(2);
	});

	it("counts only block-level markers, so a tool parameter named cache_control keeps the lookback slot", async () => {
		const tool = {
			name: "configure",
			description: "Configure caching",
			parameters: Type.Object({ cache_control: Type.Object({ ttl: Type.String() }) }),
		};
		const messages = [user("task"), assistant(collapse, [{ ...toolCall("c1", "configure") }]), toolResult("c1")];
		const payload = await capture(collapse, transcript(messages, [readTool, tool]));
		expect(markers(payload)).toHaveLength(4);
	});
});
