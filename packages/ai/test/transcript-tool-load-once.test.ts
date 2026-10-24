import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Api, Context, Message, Model, Tool } from "../src/types.ts";
import { resolveTranscriptTools } from "../src/utils/transcript.ts";
import { getToolLoadingMode } from "../src/utils/tool-loading.ts";

class PayloadCaptured extends Error {}

const tool = (name: string): Tool => ({ name, description: `${name} tool`, parameters: Type.Object({}) });
const baseTool = tool("base_tool");
const firstLoaded = tool("loaded_one");
const secondLoaded = tool("loaded_two");

async function capturePayload(model: Model<Api>, messages: Message[]): Promise<unknown> {
	let captured: unknown;
	const context: Context = { messages };
	const stream = streamSimple(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (captured === undefined) throw new Error("Expected payload capture");
	return captured;
}

const modelBase = {
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

/** Transports whose tool loading mode is `none`: a load can only rewrite the top-level tool list. */
const transports: Array<{ label: string; model: Model<Api>; names: (payload: unknown) => string[] }> = [
	{
		label: "anthropic-messages without supportsMidConvoToolChanges",
		model: {
			...modelBase,
			id: "claude-custom",
			name: "Claude custom",
			api: "anthropic-messages",
			provider: "anthropic",
			compat: { supportsMidConvoSystemMessages: true },
		},
		names: (payload) => (payload as { tools?: Array<{ name: string }> }).tools?.map((entry) => entry.name) ?? [],
	},
	{
		label: "openai-completions collapse (no mid-conversation system messages)",
		model: { ...modelBase, id: "custom-model", name: "Custom", api: "openai-completions", provider: "custom" },
		names: (payload) =>
			(payload as { tools?: Array<{ function?: { name: string } }> }).tools?.map(
				(entry) => entry.function?.name ?? "",
			) ?? [],
	},
];

describe("one tool load event on a transport without native tool loading", () => {
	test.each(transports)("changes the top-level tool list exactly once: $label", async ({ model, names }) => {
		const initial: Message[] = [
			{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
			{ role: "user", content: "first", timestamp: 1 },
		];
		// One system message announces both tools: one load event.
		const load: Message[] = [
			{ role: "system", content: "", toolsAdded: [firstLoaded, secondLoaded], timestamp: 2 },
			{ role: "user", content: "after the load", timestamp: 3 },
		];
		const later: Message[] = [{ role: "user", content: "after the load, again", timestamp: 4 }];

		expect(getToolLoadingMode(model)).toBe("none");
		expect(resolveTranscriptTools([...initial, ...load], "none").requestTools).toEqual([
			baseTool,
			firstLoaded,
			secondLoaded,
		]);

		const requests = [initial, [...initial, ...load], [...initial, ...load, ...later]];
		const lists: string[][] = [];
		for (const messages of requests) lists.push(names(await capturePayload(model, messages)));

		expect(lists[0]).toEqual(["base_tool"]);
		// The load adds both tools in one step, not one rewrite per tool.
		expect(lists[1]).toEqual(["base_tool", "loaded_one", "loaded_two"]);
		// Without a new load, the list stays identical.
		expect(lists[2]).toEqual(lists[1]);
		const changes = lists.slice(1).filter((list, index) => JSON.stringify(list) !== JSON.stringify(lists[index]));
		expect(changes).toHaveLength(1);
	});
});
