import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-responses.ts";
import type { Message, Model, StreamOptions, SystemMessage, Tool, TranscriptContext } from "../src/types.ts";
import { getSystemMessageText } from "../src/utils/text.ts";

const terminal = {
	type: "response.completed",
	response: {
		id: "resp_test",
		status: "completed",
		output: [],
		usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
	},
};

const model: Model<"openai-responses"> = {
	id: "capable-model",
	name: "Capable model",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true },
};

const head: SystemMessage = {
	role: "system",
	content: "You are a coding agent.",
	sections: { docs: "Docs.", addendum: "Addendum.", project_context: "Project.", skills: "Skills." },
	timestamp: 0,
};
const user: Message = { role: "user", content: "task", timestamp: 1 };
const context = (leading: SystemMessage = head, ...rest: Message[]) =>
	({ messages: [leading, user, ...rest] }) as TranscriptContext;

interface Block {
	type: string;
	text: string;
	prompt_cache_breakpoint?: { mode: string; ttl: string };
}
interface Payload {
	input: { role?: string; content?: Block[] | string; type?: string; tools?: { name: string }[] }[];
	tools?: { name: string }[];
	prompt_cache_options?: { mode?: string; ttl?: string };
}
interface Captured {
	payload: Payload;
	headers: Headers;
}

async function capture(
	target: Model<"openai-responses">,
	transcript: TranscriptContext,
	options: StreamOptions = {},
): Promise<Captured> {
	let captured: Captured | undefined;
	const result = await streamSimple(target, transcript, {
		apiKey: "sk-fake",
		sessionId: "session-1",
		...options,
		fetch: async (_url, init) => {
			captured = {
				payload: JSON.parse(String(init?.body)) as Payload,
				headers: new Headers(init?.headers),
			};
			return new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	}).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	return captured!;
}

const layered: StreamOptions = { cacheRetention: "short", instructionCacheRetention: "long" };

describe("OpenAI Responses instruction cache boundary", () => {
	it("splits the leading instructions into two breakpointed blocks that join to the single-block text", async () => {
		const { payload } = await capture(model, context(), { ...layered, instructionCacheBoundary: "project_context" });
		const blocks = payload.input[0].content as Block[];
		expect(blocks).toHaveLength(2);
		expect(blocks.map((block) => block.prompt_cache_breakpoint)).toEqual([
			{ mode: "explicit", ttl: "12h" },
			{ mode: "explicit", ttl: "12h" },
		]);
		expect(blocks[0].text).toBe("You are a coding agent.\n\nDocs.\n\nAddendum.\n\n");
		expect(blocks[1].text).toBe("Project.\n\nSkills.");
		expect(blocks.map((block) => block.text).join("")).toBe(getSystemMessageText(head));
		expect(JSON.stringify(payload.input.slice(1))).not.toContain("prompt_cache_breakpoint");
	});

	it("sends the volatile sections as a third block without a breakpoint", async () => {
		const boundaries = { instructionCacheBoundary: "project_context", instructionVolatileBoundary: "skills" };
		const { payload } = await capture(model, context(), { ...layered, ...boundaries });
		const blocks = payload.input[0].content as Block[];
		expect(blocks).toEqual([
			{
				type: "input_text",
				text: "You are a coding agent.\n\nDocs.\n\nAddendum.\n\n",
				prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" },
			},
			{ type: "input_text", text: "Project.\n\n", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } },
			{ type: "input_text", text: "Skills." },
		]);
		expect(blocks.map((block) => block.text).join("")).toBe(getSystemMessageText(head));
		// Without explicit breakpoints the instructions are one string: the same text in the same order.
		const implicit = await capture({ ...model, compat: {} }, context(), { ...layered, ...boundaries });
		expect(implicit.payload.input[0].content).toBe(getSystemMessageText(head));
	});

	it("uses the short instruction TTL on both blocks", async () => {
		const { payload } = await capture(model, context(), {
			cacheRetention: "short",
			instructionCacheRetention: "short",
			instructionCacheBoundary: "addendum",
		});
		const blocks = payload.input[0].content as Block[];
		expect(blocks.map((block) => block.prompt_cache_breakpoint?.ttl)).toEqual(["30m", "30m"]);
	});

	it("sends one block when no boundary is given", async () => {
		const { payload } = await capture(model, context(), layered);
		expect(payload.input[0].content).toEqual([
			{
				type: "input_text",
				text: getSystemMessageText(head),
				prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" },
			},
		]);
	});

	it("sends one block when the boundary names no section", async () => {
		const { payload } = await capture(model, context(), { ...layered, instructionCacheBoundary: "missing" });
		expect(payload.input[0].content).toHaveLength(1);
	});

	it("sends one block for a forced (opaque) prompt without sections", async () => {
		const forced: SystemMessage = { role: "system", content: "Forced prompt.", timestamp: 0 };
		const { payload } = await capture(model, context(forced), {
			...layered,
			instructionCacheBoundary: "project_context",
		});
		expect(payload.input[0].content).toEqual([
			{ type: "input_text", text: "Forced prompt.", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } },
		]);
	});

	it("does not split without an instruction breakpoint", async () => {
		const { payload } = await capture(model, context(), {
			cacheRetention: "long",
			instructionCacheRetention: undefined,
			instructionCacheBoundary: "project_context",
		});
		expect(typeof payload.input[0].content).toBe("string");
	});

	it("does not split on a model without explicit cache mode", async () => {
		const { payload } = await capture({ ...model, compat: {} }, context(), {
			...layered,
			instructionCacheBoundary: "project_context",
		});
		expect(typeof payload.input[0].content).toBe("string");
	});
});

describe("OpenAI Responses retention TTL", () => {
	it("sends a 12h request TTL for long history on explicit-mode models", async () => {
		const { payload } = await capture(model, context(), { cacheRetention: "long", instructionCacheRetention: "long" });
		expect(payload.prompt_cache_options).toEqual({ ttl: "12h" });
	});

	it("sends no request TTL for short history, and explicit mode for none", async () => {
		expect((await capture(model, context(), { cacheRetention: "short" })).payload.prompt_cache_options).toBeUndefined();
		expect((await capture(model, context(), { cacheRetention: "none" })).payload.prompt_cache_options).toEqual({
			mode: "explicit",
		});
	});
});

describe("xAI Responses session routing", () => {
	const xai = { ...model, provider: "xai", baseUrl: "https://api.x.ai/v1", compat: {} } as Model<"openai-responses">;

	it("sends x-grok-conv-id with the session id", async () => {
		const { headers } = await capture(xai, context());
		expect(headers.get("x-grok-conv-id")).toBe("session-1");
		expect(headers.get("x-client-request-id")).toBe("session-1");
	});

	it("omits it without a session id", async () => {
		const { headers } = await capture(xai, context(), { sessionId: undefined });
		expect(headers.has("x-grok-conv-id")).toBe(false);
	});

	it("omits it for other providers", async () => {
		const { headers } = await capture(model, context());
		expect(headers.has("x-grok-conv-id")).toBe(false);
	});
});

describe("OpenAI Responses tool loading mode", () => {
	const tool = (name: string): Tool => ({ name, description: name, parameters: Type.Object({}) });
	const withTools = (): TranscriptContext => {
		const leading: SystemMessage = { ...head, toolsAdded: [tool("base")] };
		const update: SystemMessage = { role: "system", content: "", toolsAdded: [tool("late")], timestamp: 2 };
		return { messages: [leading, user, update, { role: "user", content: "again", timestamp: 3 }] } as TranscriptContext;
	};
	const names = (items: { name: string }[] | undefined) => items?.map((item) => item.name);

	it("falls back to a plain tool list when tool search lacks mid-conversation system messages", async () => {
		const searchOnly = { ...model, compat: { supportsToolSearch: true } } as Model<"openai-responses">;
		const { payload } = await capture(searchOnly, withTools());
		expect(names(payload.tools)).toEqual(["base", "late"]);
		expect(payload.input.some((item) => item.type === "tool_search_call")).toBe(false);
	});

	it("anchors additions in the transcript when mid-conversation system messages are supported", async () => {
		const searchable = {
			...model,
			compat: { supportsToolSearch: true, supportsMidConvoSystemMessages: true },
		} as Model<"openai-responses">;
		const { payload } = await capture(searchable, withTools());
		expect(payload.input.some((item) => item.type === "tool_search_call")).toBe(true);
	});
});
