import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { capCacheBreakpoints, countCacheBreakpoints } from "../src/api/anthropic-messages/cache-breakpoints.ts";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Message, Model, StreamOptions } from "../src/types.ts";
import { CACHE_PROFILES } from "../src/utils/cache-profiles.ts";
import { assistant, grepTool, readTool, transcript, user } from "./anthropic-cache-fixtures.ts";
import { bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";

/** The runtime four-marker guard, and the one diagnostic each cache downgrade emits. */

const sonnet = getBuiltinModel("anthropic", "claude-sonnet-4-5");
const claude = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const nova = getBuiltinModel("amazon-bedrock", "us.amazon.nova-pro-v1:0");

const sse = (events: object[]) =>
	new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
const anthropicReply = () =>
	sse([
		{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);

const turns = (model: Model<any>, count: number): Message[] => {
	const messages: Message[] = [user("task")];
	for (let i = 0; i < count; i++) messages.push(assistant(model, [{ type: "text", text: `a${i}` }]), user(`u${i}`));
	return messages;
};

async function anthropicRequest(model: Model<"anthropic-messages">, messages: Message[], options: StreamOptions) {
	let payload: Record<string, unknown> | undefined;
	const reply = await anthropicStream(model, transcript(messages, [readTool, grepTool]), {
		apiKey: "sk-ant-api-test",
		env: {},
		fetch: async () => anthropicReply(),
		...options,
		onPayload: (value) => {
			payload = structuredClone(value) as Record<string, unknown>;
			return value;
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return { payload, reply };
}

async function bedrockRequest(model: Model<"bedrock-converse-stream">, messages: Message[], options: StreamOptions) {
	let payload: Record<string, unknown> | undefined;
	const reply = await bedrockStream(model, transcript(messages, [readTool, grepTool]), {
		env: {},
		apiKey: "test",
		fetch: async () => bedrockResponse(bedrockTextEvents),
		...options,
		onPayload: (value) => {
			payload = structuredClone(value) as Record<string, unknown>;
			return value;
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return { payload, reply };
}

function cachePoints(payload: Record<string, unknown>): number {
	const body = payload as { system?: object[]; toolConfig?: { tools: object[] }; messages: { content: object[] }[] };
	return [...(body.system ?? []), ...(body.toolConfig?.tools ?? []), ...body.messages.flatMap((m) => m.content)].filter(
		(block) => "cachePoint" in block,
	).length;
}

const diagnostic = (reply: { diagnostics?: { type: string }[] }, type: string) =>
	(reply.diagnostics ?? []).filter((d) => d.type === type);

const MATRIX = {
	cacheRetention: [undefined, "none", "short", "long"],
	instructionCacheRetention: [undefined, "none", "short", "long"],
	toolCacheBoundary: [undefined, "grep"],
	instructionCacheBoundary: [undefined, "project_context", "docs"],
	instructionVolatileBoundary: [undefined, "project_context"],
	historyTurns: [0, 1, 3],
} as const;

function* matrix() {
	for (const cacheRetention of MATRIX.cacheRetention)
		for (const instructionCacheRetention of MATRIX.instructionCacheRetention)
			for (const toolCacheBoundary of MATRIX.toolCacheBoundary)
				for (const instructionCacheBoundary of MATRIX.instructionCacheBoundary)
					for (const instructionVolatileBoundary of MATRIX.instructionVolatileBoundary)
						for (const historyTurns of MATRIX.historyTurns)
							yield {
								historyTurns,
								options: {
									cacheRetention,
									instructionCacheRetention,
									toolCacheBoundary,
									instructionCacheBoundary,
									instructionVolatileBoundary,
								} as StreamOptions,
							};
}

describe("capCacheBreakpoints", () => {
	const mark = { type: "ephemeral" };
	it("keeps the last four Anthropic markers and leaves tool schemas alone", () => {
		const body = {
			tools: [{ name: "t", input_schema: { cache_control: mark }, cache_control: mark }],
			system: [
				{ text: "a", cache_control: mark },
				{ text: "b", cache_control: mark },
			],
			messages: [
				{ role: "user", content: [{ text: "c", cache_control: mark }] },
				{
					role: "user",
					content: [
						{ text: "d", cache_control: mark },
						{ type: "tool_use", input: { cache_control: 1 } },
					],
				},
			],
		};
		expect(countCacheBreakpoints(body)).toBe(5);
		expect(capCacheBreakpoints(body, 4)).toBe(1);
		expect(countCacheBreakpoints(body)).toBe(4);
		expect(body.tools[0]).not.toHaveProperty("cache_control");
		expect(body.tools[0].input_schema).toHaveProperty("cache_control");
		expect(body.messages[1].content[0]).toHaveProperty("cache_control");
	});

	it("removes Bedrock cache point blocks, earliest first", () => {
		const point = { cachePoint: { type: "default" } };
		const body = {
			system: [{ text: "a" }, point, { text: "b" }, { ...point }],
			toolConfig: { tools: [{ toolSpec: { name: "x" } }, { ...point }] },
			messages: [{ role: "user", content: [{ text: "c" }, { ...point }] }],
		};
		expect(capCacheBreakpoints(body, 2)).toBe(2);
		expect(body.toolConfig.tools).toEqual([{ toolSpec: { name: "x" } }]);
		expect(body.system).toEqual([{ text: "a" }, { text: "b" }, point]);
		expect(body.messages[0].content).toHaveLength(2);
	});

	it("changes nothing at or under the limit", () => {
		const body = { system: [{ text: "a", cache_control: mark }] };
		expect(capCacheBreakpoints(body, 4)).toBe(0);
		expect(body.system[0]).toHaveProperty("cache_control");
	});
});

describe("marker count across the cache-profile matrix", () => {
	it("never sends more than four markers to Anthropic", async () => {
		let checked = 0;
		for (const { options, historyTurns } of matrix()) {
			const { payload } = await anthropicRequest(sonnet, turns(sonnet, historyTurns), options);
			expect(
				countCacheBreakpoints([payload.system, payload.tools, payload.messages]),
				JSON.stringify(options),
			).toBeLessThanOrEqual(CACHE_PROFILES.anthropic.maxMarkers);
			checked++;
		}
		expect(checked).toBe(4 * 4 * 2 * 3 * 2 * 3);
	}, 120_000);

	it("never sends more than four cache points to Bedrock Claude or Nova", async () => {
		for (const model of [claude, nova])
			for (const { options, historyTurns } of matrix()) {
				const { payload } = await bedrockRequest(model, turns(model, historyTurns), options);
				expect(cachePoints(payload), `${model.id} ${JSON.stringify(options)}`).toBeLessThanOrEqual(4);
			}
	}, 240_000);
});

describe("cache downgrade diagnostics", () => {
	const proxy = { ...sonnet, baseUrl: "https://proxy.example.com" } as Model<"anthropic-messages">;

	it("reports a 1h request on an unverified Anthropic host once, and nothing when 1h is sent or not asked", async () => {
		const downgraded = await anthropicRequest(proxy, [user("task")], { cacheRetention: "long" });
		expect(diagnostic(downgraded.reply, "cache_retention_downgraded")).toEqual([
			expect.objectContaining({ details: expect.objectContaining({ requested: "1h", sent: "5m", model: proxy.id }) }),
		]);
		for (const [model, cacheRetention] of [
			[sonnet, "long"],
			[proxy, "short"],
			[proxy, "none"],
		] as const) {
			const quiet = await anthropicRequest(model, [user("task")], {
				cacheRetention,
				instructionCacheRetention: cacheRetention === "long" ? "long" : "none",
			});
			expect(quiet.reply.diagnostics ?? []).toEqual([]);
		}
		// A lasting setup is reported once per process, not on every reply; another host is another setup.
		const again = await anthropicRequest(proxy, [user("task")], { cacheRetention: "long" });
		expect(again.reply.diagnostics ?? []).toEqual([]);
		const other = { ...proxy, baseUrl: "https://other.example.com" } as Model<"anthropic-messages">;
		const first = await anthropicRequest(other, [user("task")], { cacheRetention: "long" });
		expect(diagnostic(first.reply, "cache_retention_downgraded")).toHaveLength(1);
	});

	it("reports a 1h request on a Bedrock Claude model not verified for it once", async () => {
		const unverified = { ...claude, compat: { supportsLongCacheRetention: false } } as Model<"bedrock-converse-stream">;
		const downgraded = await bedrockRequest(unverified, [user("task")], { cacheRetention: "long" });
		expect(diagnostic(downgraded.reply, "cache_retention_downgraded")).toHaveLength(1);
		for (const [model, options] of [
			[claude, { cacheRetention: "long" }],
			[unverified, { cacheRetention: "short", instructionCacheRetention: "short" }],
			[nova, { cacheRetention: "long" }],
		] as const) {
			const quiet = await bedrockRequest(model, [user("task")], options);
			expect(quiet.reply.diagnostics ?? []).toEqual([]);
		}
	});

	it("reports Nova markers stripped past the estimated 20K tokens once, and nothing under it", async () => {
		const big = "word ".repeat(60_000);
		const over = await bedrockRequest(
			nova,
			[user(big), assistant(nova as Model<any>, [{ type: "text", text: "ok" }]), user("more")],
			{
				cacheRetention: "short",
			},
		);
		expect(diagnostic(over.reply, "cache_markers_stripped")).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ maxCachedTokens: 20_000, stripped: expect.any(Number) }),
			}),
		]);
		const small = await bedrockRequest(nova, [user("task")], { cacheRetention: "short" });
		expect(small.reply.diagnostics ?? []).toEqual([]);
	});
});
