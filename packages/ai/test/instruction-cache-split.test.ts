import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { countCacheBreakpoints } from "../src/api/anthropic-messages/cache-breakpoints.ts";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model, StreamOptions, SystemMessage } from "../src/types.ts";
import { splitSystemMessageAtBoundary } from "../src/utils/instruction-split.ts";
import { getSystemMessageText } from "../src/utils/text.ts";
import { normalizeContext, type TranscriptContext } from "../src/utils/transcript.ts";

const SECTIONS = { docs: "<docs>d</docs>", project_context: "<project>p</project>", cwd: "<cwd>/w</cwd>" };
const tools = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];

function systemMessage(sections?: Record<string, string | null>): SystemMessage {
	return { role: "system", content: "Base prompt", ...(sections ? { sections } : {}), timestamp: 0 };
}

/** `sections` null builds an opaque prompt without sections. */
function contextWith(messages: Message[], sections: Record<string, string | null> | null = SECTIONS) {
	const base = normalizeContext({ systemPrompt: "unused", messages, tools });
	const [initial, ...rest] = base.messages;
	return {
		messages: [{ ...(initial as SystemMessage), ...systemMessage(sections ?? undefined) }, ...rest],
	} as TranscriptContext;
}

function assistant(model: Model<any>, content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	} as AssistantMessage;
}

class Captured extends Error {}

async function capture<T>(
	run: (options: StreamOptions) => { result(): Promise<unknown> },
	options: StreamOptions = {},
): Promise<T> {
	let payload: T | undefined;
	await run({
		...options,
		onPayload: (value) => {
			payload = value as T;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

const simple: Message[] = [{ role: "user", content: "Task", timestamp: 1 }];
const ISOLATED = { env: { OCTOCODE_CACHE_RETENTION: "long" } } satisfies StreamOptions;

beforeEach(() => {
	// The caller's retention preferences would change the TTLs asserted below.
	vi.stubEnv("OCTOCODE_CACHE_RETENTION", undefined);
	vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("splitSystemMessageAtBoundary", () => {
	it("splits before the boundary section and rejoins to the single-block text", () => {
		const message = systemMessage(SECTIONS);
		const split = splitSystemMessageAtBoundary(message, "project_context");
		expect(split?.[0]).toBe("Base prompt\n\n<docs>d</docs>\n\n");
		expect(split?.[1]).toBe("<project>p</project>\n\n<cwd>/w</cwd>");
		expect(split?.join("")).toBe(getSystemMessageText(message));
	});

	it("keeps one block without a boundary, with an unknown section or with an opaque prompt", () => {
		expect(splitSystemMessageAtBoundary(systemMessage(SECTIONS), undefined)).toBeUndefined();
		expect(splitSystemMessageAtBoundary(systemMessage(SECTIONS), "missing")).toBeUndefined();
		expect(splitSystemMessageAtBoundary(systemMessage(), "project_context")).toBeUndefined();
		expect(splitSystemMessageAtBoundary(systemMessage({ ...SECTIONS, project_context: null }), "cwd")).toEqual([
			"Base prompt\n\n<docs>d</docs>\n\n",
			"<cwd>/w</cwd>",
		]);
		expect(splitSystemMessageAtBoundary(systemMessage({ project_context: "p" }), "project_context")).toBeDefined();
		expect(splitSystemMessageAtBoundary({ ...systemMessage({ a: "x" }), content: "" }, "a")).toBeUndefined();
	});
});

describe("Anthropic instruction split", () => {
	const model: Model<"anthropic-messages"> = getBuiltinModel("anthropic", "claude-haiku-4-5");
	type Payload = {
		system: { text: string; cache_control?: { ttl?: string } }[];
		tools: { cache_control?: unknown }[];
		messages: unknown[];
	};
	const run = (context: TranscriptContext, options: StreamOptions = {}, apiKey = "sk-ant-api-test") =>
		capture<Payload>((o) => anthropicStream(model, context, { apiKey, ...o }), { ...ISOLATED, ...options });

	it("moves the tools marker onto a second system block without changing the marker count", async () => {
		const context = contextWith(simple);
		const single = await run(context);
		const split = await run(context, { instructionCacheBoundary: "project_context" });
		expect(single.system).toHaveLength(1);
		expect(single.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(split.system).toHaveLength(2);
		expect(split.system.map((block) => block.text).join("")).toBe(single.system[0].text);
		expect(split.system.map((block) => block.cache_control)).toEqual([
			{ type: "ephemeral", ttl: "1h" },
			{ type: "ephemeral", ttl: "1h" },
		]);
		expect(countCacheBreakpoints(split.tools)).toBe(0);
		expect(countCacheBreakpoints([split.system, split.tools, split.messages])).toBe(
			countCacheBreakpoints([single.system, single.tools, single.messages]),
		);
	});

	it("keeps one block for no boundary, an unknown section and an opaque prompt", async () => {
		for (const [boundary, sections] of [
			[undefined, SECTIONS],
			["missing", SECTIONS],
			["project_context", null],
		] as const) {
			const payload = await run(contextWith(simple, sections), { instructionCacheBoundary: boundary });
			expect(payload.system).toHaveLength(1);
			expect(payload.tools.at(-1)?.cache_control).toBeDefined();
		}
	});

	it("keeps one block when instruction caching is off", async () => {
		const payload = await run(contextWith(simple), {
			cacheRetention: "none",
			instructionCacheBoundary: "project_context",
			env: {},
		});
		expect(payload.system).toHaveLength(1);
		expect(countCacheBreakpoints([payload.system, payload.tools, payload.messages])).toBe(0);
	});

	it("keeps the one-hour instruction TTL before the five-minute history TTL", async () => {
		const payload = await run(contextWith(simple), {
			cacheRetention: "short",
			instructionCacheRetention: "long",
			instructionCacheBoundary: "project_context",
		});
		expect(payload.system.map((block) => block.cache_control)).toEqual([
			{ type: "ephemeral", ttl: "1h" },
			{ type: "ephemeral", ttl: "1h" },
		]);
		const last = (payload.messages.at(-1) as { content: { cache_control?: unknown }[] }).content.at(-1);
		expect(last?.cache_control).toEqual({ type: "ephemeral" });
	});
});

describe("Bedrock Claude checkpoints", () => {
	const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
	type Point = { cachePoint?: { ttl?: string } };
	type Payload = {
		system: ({ text?: string } & Point)[];
		toolConfig?: { tools: Point[] };
		messages: { content: Point[] }[];
	};
	const run = (options: StreamOptions = {}, context = contextWith(simple)) =>
		capture<Payload>((o) => bedrockStream(model, context, o), { ...ISOLATED, ...options });
	const total = (payload: Payload) =>
		[...payload.system, ...(payload.toolConfig?.tools ?? []), ...payload.messages.flatMap((m) => m.content)].filter(
			(block) => block.cachePoint,
		).length;

	it("adds a tools checkpoint with the instruction retention before the system checkpoint", async () => {
		const payload = await run({ cacheRetention: "short", instructionCacheRetention: "long" });
		expect(payload.toolConfig?.tools.at(-1)?.cachePoint?.ttl).toBeDefined();
		expect(payload.toolConfig?.tools).toHaveLength(2);
		expect(payload.system.filter((block) => block.cachePoint)).toHaveLength(1);
		expect(payload.messages.at(-1)?.content.at(-1)?.cachePoint?.ttl).toBeUndefined();
		expect(total(payload)).toBe(3);
	});

	it("omits the one-hour TTL when the model does not support long retention", async () => {
		const noLong = { ...model, compat: { ...model.compat, supportsLongCacheRetention: false } };
		const payload = await capture<Payload>((o) => bedrockStream(noLong, contextWith(simple), o), ISOLATED);
		expect(payload.toolConfig?.tools.at(-1)?.cachePoint?.ttl).toBeUndefined();
		expect(payload.toolConfig?.tools.at(-1)?.cachePoint).toBeDefined();
	});

	it("adds no checkpoints when caching is off, and none to a tool-free request", async () => {
		const off = await run({ cacheRetention: "none", env: {} });
		expect(total(off)).toBe(0);
		const noTools = await run({}, normalizeContext({ systemPrompt: "Be brief.", messages: simple }));
		expect(noTools.toolConfig).toBeUndefined();
		expect(total(noTools)).toBe(2);
	});

	it("splits the system prompt at the boundary within four checkpoints", async () => {
		const single = await run();
		const split = await run({ instructionCacheBoundary: "project_context" });
		expect(split.system.map((block) => block.text ?? "").join("")).toBe(single.system[0].text);
		expect(split.system.map((block) => (block.cachePoint ? "point" : "text"))).toEqual([
			"text",
			"point",
			"text",
			"point",
		]);
		// The base system point covers the tools before it, so a split prompt drops the tools point.
		expect(split.toolConfig?.tools.some((tool) => tool.cachePoint)).toBe(false);
		expect(total(split)).toBe(3);
		expect(total(single)).toBe(3);
		// That frees the slot for the previous request's tail on a later turn.
		const turns: Message[] = [
			...simple,
			assistant(model, [{ type: "text", text: "Done." }], "stop"),
			{ role: "user", content: "Next.", timestamp: 0 },
		];
		const later = await run({ instructionCacheBoundary: "project_context" }, contextWith(turns));
		expect(later.messages.map((message) => message.content.some((block) => block.cachePoint))).toEqual([
			true,
			false,
			true,
		]);
		expect(total(later)).toBe(4);
		const opaque = await run({ instructionCacheBoundary: "project_context" }, contextWith(simple, null));
		expect(opaque.system).toHaveLength(2);
		expect(total(opaque)).toBe(3);
	});
});

describe("OpenRouter Claude breakpoints", () => {
	const model = getBuiltinModel("openrouter", "anthropic/claude-fable-5.1:batch");
	type Part = { text: string; cache_control?: { ttl?: string } };
	type Payload = { messages: { role: string; content: Part[] | string }[]; tools?: { cache_control?: unknown }[] };
	const run = (context: TranscriptContext, options: StreamOptions = {}) =>
		capture<Payload>((o) => completionsStream(model, context, { apiKey: "test-key", ...o }), {
			...ISOLATED,
			...options,
		});
	const marked = (payload: Payload) => countCacheBreakpoints([payload.messages, payload.tools]);
	const toolTurn: Message[] = [
		{ role: "user", content: "one", timestamp: 1 },
		assistant(model, [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }], "toolUse"),
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: 2,
		},
		assistant(model, [{ type: "text", text: "done" }], "stop"),
		{ role: "user", content: "two", timestamp: 3 },
	];

	it("marks the previous tail with the fourth breakpoint and never exceeds four", async () => {
		const payload = await run(contextWith(toolTurn));
		expect(marked(payload)).toBe(4);
		const toolMessage = payload.messages.find((message) => message.role === "tool")!;
		expect((toolMessage.content as Part[])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect((payload.messages.at(-1)!.content as Part[])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("uses the history retention for the lookback breakpoint", async () => {
		const payload = await run(contextWith(toolTurn), { cacheRetention: "short", instructionCacheRetention: "long" });
		const toolMessage = payload.messages.find((message) => message.role === "tool")!;
		expect((toolMessage.content as Part[])[0].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("adds no lookback on the first request or without history caching", async () => {
		expect(marked(await run(contextWith(simple)))).toBe(3);
		expect(marked(await run(contextWith(toolTurn), { cacheRetention: "none", env: {} }))).toBe(0);
	});

	it("splits the system prompt and moves the tools marker so four markers still suffice", async () => {
		const context = contextWith(toolTurn);
		const single = await run(context);
		const split = await run(context, { instructionCacheBoundary: "project_context" });
		const singleSystem = single.messages.find((m) => m.role === "system" || m.role === "developer")!;
		const splitSystem = split.messages.find((m) => m.role === "system" || m.role === "developer")!;
		expect(splitSystem.content as Part[]).toHaveLength(2);
		expect((splitSystem.content as Part[]).map((part) => part.text).join("")).toBe(
			(singleSystem.content as Part[])[0].text,
		);
		expect((splitSystem.content as Part[]).map((part) => part.cache_control?.ttl)).toEqual(["1h", "1h"]);
		expect(split.tools?.at(-1)?.cache_control).toBeUndefined();
		expect(marked(split)).toBe(4);
		expect(marked(await run(contextWith(simple), { instructionCacheBoundary: "project_context" }))).toBe(3);
	});

	it("keeps one block for an unknown boundary or an opaque prompt", async () => {
		for (const [boundary, sections] of [
			["missing", SECTIONS],
			["project_context", null],
		] as const) {
			const payload = await run(contextWith(toolTurn, sections), { instructionCacheBoundary: boundary });
			const system = payload.messages.find((m) => m.role === "system" || m.role === "developer")!;
			expect(system.content as Part[]).toHaveLength(1);
			expect(payload.tools?.at(-1)?.cache_control).toBeDefined();
			expect(marked(payload)).toBe(4);
		}
	});

	it("recognizes ~anthropic/ ids at runtime", async () => {
		const alias = { ...model, id: "~anthropic/claude-custom-latest", compat: undefined };
		const payload = await capture<Payload>(
			(o) => completionsStream(alias, contextWith(simple), { apiKey: "k", ...o }),
			ISOLATED,
		);
		expect(marked(payload)).toBe(3);
	});
});
