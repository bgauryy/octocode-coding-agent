import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Message, Model, StreamOptions, Tool } from "../src/types.ts";
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

/** A tool only some roles declare, after the shared prefix (`toolCacheBoundary`). */
const roleTool: Tool = {
	name: "agent",
	description: "Start a subagent",
	parameters: Type.Object({ goal: Type.String() }),
};

const cases = [collapse, native].flatMap((model) =>
	["sk-ant-api-test"].flatMap((apiKey) =>
		[undefined, "project_context"].flatMap((boundary) =>
			[undefined, "agent"].flatMap((toolBoundary) =>
				retentions.flatMap((retention) =>
					histories.map((history) => ({ model, apiKey, boundary, toolBoundary, retention, history })),
				),
			),
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
		"$model.id key=$apiKey boundary=$boundary tools=$toolBoundary retention=$retention.name: $history.name",
		async ({ model, apiKey, boundary, toolBoundary, retention, history }) => {
			const payload = await capture(model, transcript(history.messages(model), [readTool, roleTool]), {
				apiKey,
				instructionCacheBoundary: boundary,
				toolCacheBoundary: toolBoundary,
				...retention.options,
			});
			expectValidPlacement(payload);

			const found = markers(payload);
			const instructions = found.filter(({ section }) => section !== "messages");
			const historyMarkers = found.filter(({ section }) => section === "messages");
			// Split: base and project blocks. Unsplit: the prompt block and the last initial tool. With a shared tool
			// prefix, its last tool takes the slot of the first marker after it (the last tool's, or the base block's).
			expect(instructions).toHaveLength(2);
			const toolMarkers = found.filter(({ section }) => section === "tools").map(({ block }) => block.name);
			const lastTool = payload.tools?.filter((tool) => tool.name !== "__octocode_deferred_placeholder__").at(-1)?.name;
			expect(toolMarkers).toEqual(toolBoundary ? ["read"] : boundary ? [] : [lastTool]);
			expect(historyMarkers).toHaveLength(history.history);
			for (const { block } of instructions) expect(block.cache_control?.ttl).toBe(retention.instructionTtl);
			for (const { block } of historyMarkers) expect(block.cache_control?.ttl).toBe(retention.historyTtl);
			if (boundary) expect(found.filter(({ section }) => section === "system")).toHaveLength(toolBoundary ? 1 : 2);
		},
	);

	it("gives two roles the same bytes and marker up to the end of their shared tools", async () => {
		const other: Tool = { ...roleTool, name: "skill", description: "Load a skill" };
		for (const model of [collapse, native]) {
			const request = (tools: Tool[], toolCacheBoundary: string) =>
				capture(model, transcript([user("task")], tools), {
					cacheRetention: "short",
					instructionCacheRetention: "long",
					instructionCacheBoundary: "project_context",
					toolCacheBoundary,
				});
			const [a, b] = [
				await request([readTool, grepTool, roleTool], "agent"),
				await request([readTool, grepTool, other], "skill"),
			];
			// Not vacuous: the role tools differ, so without the marker the first cache point (the last tool) differs.
			expect(JSON.stringify(a.tools)).not.toBe(JSON.stringify(b.tools));
			expect(JSON.stringify(a.tools?.slice(0, 2))).toBe(JSON.stringify(b.tools?.slice(0, 2)));
			expect(a.tools?.[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
			expect(markers(a)).toHaveLength(markers(b).length);
			expect(markers(a).length).toBeLessThanOrEqual(4);
		}
	});

	it("ignores a tool boundary that names the first tool or no tool", async () => {
		for (const toolCacheBoundary of ["read", "missing"]) {
			const payload = await capture(collapse, transcript([user("task")], [readTool, roleTool]), {
				cacheRetention: "long",
				toolCacheBoundary,
			});
			expect(
				markers(payload)
					.filter(({ section }) => section === "tools")
					.map(({ block }) => block.name),
			).toEqual(["agent"]);
		}
	});

	it("keeps native tool changes off the top-level tool list", async () => {
		const history = histories[2];
		const payload = await capture(native, transcript(history.messages(native)));
		expect(payload.tools?.map((tool) => tool.name)).toEqual(["read", "__octocode_deferred_placeholder__"]);
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
