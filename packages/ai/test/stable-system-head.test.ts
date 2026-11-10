import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import type { Message, Model, SystemMessage, Tool, TranscriptContext } from "../src/types.ts";
import { collapseSystemMessages, foldSystemMessages, normalizeContext } from "../src/utils/transcript.ts";

class PayloadCaptured extends Error {}

const tool = (name: string): Tool => ({ name, description: `${name} tool`, parameters: Type.Object({}) });

const head: SystemMessage = {
	role: "system",
	content: "You are a coding agent.",
	sections: { mcp: "<mcp>none</mcp>" },
	toolsAdded: [tool("read")],
	timestamp: 1,
};
const patch: SystemMessage = {
	role: "system",
	content: "",
	sections: { mcp: "<mcp>docs connected</mcp>" },
	timestamp: 3,
};
const secondPatch: SystemMessage = {
	...patch,
	sections: { mcp: "<mcp>docs and search connected</mcp>" },
	timestamp: 5,
};

const history: Message[] = [
	{ role: "user", content: "hello", timestamp: 2 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
		api: "openai-completions",
		provider: "test",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "file" }],
		isError: false,
		timestamp: 2,
	},
];

const before: TranscriptContext = { messages: [head, ...history] } as TranscriptContext;
// The patch lands between the tool call and its result, and the second after the result.
const after: TranscriptContext = {
	messages: [head, history[0], history[1], patch, history[2], secondPatch],
} as TranscriptContext;

async function capture(
	run: (options: { apiKey: string; onPayload: (payload: unknown) => never }) => AsyncIterable<unknown>,
): Promise<unknown> {
	let payload: unknown;
	const options = {
		apiKey: "test",
		onPayload: (value: unknown) => {
			payload = value;
			throw new PayloadCaptured();
		},
	};
	for await (const event of run(options)) void event;
	return payload;
}

const bedrockModel: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1000,
};
const googleModel: Model<"google-generative-ai"> = {
	id: "gemini-3-pro",
	name: "Gemini Pro",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1000,
};
const completionsModel: Model<"openai-completions"> = {
	...bedrockModel,
	id: "vendor/model",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
};

interface BedrockPayload {
	system: unknown;
	messages: { role: string; content: Record<string, unknown>[] }[];
	toolConfig?: unknown;
}
interface GooglePayload {
	config: { systemInstruction?: string; tools?: unknown };
	contents: { role: string; parts: Record<string, unknown>[] }[];
}
interface CompletionsPayload {
	messages: { role: string; content: unknown }[];
	tools?: unknown;
}

const UPDATE = "[System update from the harness";

describe("stable prompt head without mid-conversation system messages", () => {
	it("keeps the Bedrock system prompt and earlier turns identical and merges updates into the tool-result turn", async () => {
		const run = (context: TranscriptContext) =>
			capture((options) =>
				streamBedrock(bedrockModel, context, { ...options, cacheRetention: "none" }),
			) as Promise<BedrockPayload>;
		const [a, b] = [await run(before), await run(after)];
		expect(b.system).toEqual(a.system);
		expect(b.toolConfig).toEqual(a.toolConfig);
		expect(b.messages.slice(0, 2)).toEqual(a.messages.slice(0, 2));
		// Converse requires alternating roles: both updates join the tool-result turn.
		expect(b.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		const turn = b.messages[2].content;
		expect(turn[0]).toHaveProperty("toolResult");
		expect(JSON.stringify(turn.slice(1))).toContain("docs connected");
		expect(JSON.stringify(turn.slice(1))).toContain("docs and search connected");
		expect(JSON.stringify(a.system)).not.toContain("docs connected");
	});

	it("keeps the Google systemInstruction and earlier contents identical", async () => {
		const run = (context: TranscriptContext) =>
			capture((options) => streamGoogle(googleModel, context, options)) as Promise<GooglePayload>;
		const [a, b] = [await run(before), await run(after)];
		expect(b.config.systemInstruction).toBe(a.config.systemInstruction);
		expect(b.config.tools).toEqual(a.config.tools);
		expect(b.contents.slice(0, 2)).toEqual(a.contents.slice(0, 2));
		const trailing = b.contents.slice(3);
		expect(trailing.every((content) => content.role === "user")).toBe(true);
		expect(JSON.stringify(trailing)).toContain("docs and search connected");
		expect(a.config.systemInstruction).not.toContain("docs connected");
	});

	it("keeps the leading message and earlier messages identical on an openai-completions provider", async () => {
		const run = (context: TranscriptContext) =>
			capture((options) => streamCompletions(completionsModel, context, options)) as Promise<CompletionsPayload>;
		const [a, b] = [await run(before), await run(after)];
		expect(b.messages.slice(0, 4)).toEqual(a.messages.slice(0, 4));
		expect(b.tools).toEqual(a.tools);
		expect(b.messages.filter((message) => message.role === "system")).toHaveLength(1);
		const updates = b.messages.slice(4);
		expect(updates.map((message) => message.role)).toEqual(["user", "user"]);
		expect(String(updates[0].content)).toContain(UPDATE);
		expect(String(updates[0].content)).toContain("docs connected");
		expect(String(updates[1].content)).toContain("docs and search connected");
	});

	// The Mistral adapter keeps a user message from following a tool result (compatibility policy, not a verified
	// hosted rejection), so an update there is folded into the head.
	it("folds Mistral updates up to one that follows a tool result into the head and keeps the turns", async () => {
		const run = (context: TranscriptContext) =>
			capture((options) =>
				streamMistral({ ...completionsModel, api: "mistral-conversations" } as never, context, options),
			) as Promise<{ messages: { role: string; content: unknown }[] }>;
		const [a, b] = [await run(before), await run(after)];
		expect(b.messages.slice(1)).toEqual(a.messages.slice(1));
		expect(b.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
		expect(JSON.stringify(a.messages[0].content)).not.toContain("docs and search connected");
		expect(JSON.stringify(b.messages[0].content)).toContain("docs and search connected");
		expect(JSON.stringify(b.messages)).not.toContain("docs connected");
	});
});

describe("collapseSystemMessages", () => {
	it("leaves a transcript without later system messages unchanged", () => {
		expect(collapseSystemMessages(before)).toBe(before);
	});

	it("keeps the head text, takes the current tools and orders updates after the tool result", () => {
		const collapsed = collapseSystemMessages(
			normalizeContext({
				messages: [
					head,
					history[0],
					history[1],
					{ ...patch, toolsAdded: [tool("docs")] },
					history[2],
					{ ...secondPatch, toolsRemoved: [{ name: "read" }] },
				],
			}),
		);
		expect(collapsed.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"user",
			"user",
		]);
		const [first] = collapsed.messages as [SystemMessage];
		expect(first.content).toBe(head.content);
		expect(first.sections).toEqual(head.sections);
		expect(first.toolsAdded?.map((entry) => entry.name)).toEqual(["docs"]);
		expect(collapseSystemMessages(collapsed)).toEqual(collapsed);
	});

	it("produces no message for a tool-only change and still applies the tool", () => {
		const collapsed = collapseSystemMessages({
			messages: [head, history[0], { role: "system", content: "", toolsAdded: [tool("docs")], timestamp: 3 }],
		} as TranscriptContext);
		expect(collapsed.messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect((collapsed.messages[0] as SystemMessage).toolsAdded?.map((entry) => entry.name)).toEqual(["read", "docs"]);
	});

	it("folds when there is no leading system message", () => {
		const context = { messages: [history[0], patch] } as TranscriptContext;
		expect(collapseSystemMessages(context)).toEqual(foldSystemMessages(context));
	});
});
