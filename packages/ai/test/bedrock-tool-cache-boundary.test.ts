import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model, StreamOptions, Tool } from "../src/types.ts";
import { grepTool, readTool, transcript, user } from "./anthropic-cache-fixtures.ts";
import { bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";

/**
 * The tool cache point at the end of the tools every role shares (`toolCacheBoundary`), as on Anthropic
 * (`anthropic-cache-breakpoint-matrix.test.ts`), and the one-time notice for an application inference profile that
 * runs uncached.
 */

type CachePoint = { type: string; ttl?: string };
type Block = { cachePoint?: CachePoint; toolSpec?: { name: string }; [key: string]: unknown };
interface Payload {
	system?: Block[];
	toolConfig?: { tools: Block[] };
	messages: { role: string; content: Block[] }[];
}

const claude = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const nova = getBuiltinModel("amazon-bedrock", "us.amazon.nova-pro-v1:0");
const roleTool: Tool = {
	name: "agent",
	description: "Start a subagent",
	parameters: Type.Object({ goal: Type.String() }),
};
const otherRoleTool: Tool = { ...roleTool, name: "skill", description: "Load a skill" };

async function request(
	model: Model<"bedrock-converse-stream">,
	tools: Tool[],
	options: StreamOptions & { toolCacheBoundary?: string; instructionCacheBoundary?: string },
) {
	let payload: Payload | undefined;
	const reply = await bedrockStream(model, transcript([user("task")], tools), {
		env: {},
		apiKey: "test",
		fetch: async () => bedrockResponse(bedrockTextEvents),
		...options,
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			return value;
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return { payload, reply };
}

const points = (payload: Payload) =>
	[
		...(payload.toolConfig?.tools ?? []),
		...(payload.system ?? []),
		...payload.messages.flatMap((m) => m.content),
	].filter((block) => block.cachePoint);
/** The tool list as names, with `|` where a cache point sits. */
const toolLayout = (payload: Payload) =>
	(payload.toolConfig?.tools ?? []).map((block) => (block.cachePoint ? "|" : block.toolSpec?.name));

describe("Bedrock tool cache boundary", () => {
	it("gives two roles the same bytes and cache point up to the end of their shared tools", async () => {
		const options = { cacheRetention: "long", instructionCacheBoundary: "project_context" } as const;
		const a = (await request(claude, [readTool, grepTool, roleTool], { ...options, toolCacheBoundary: "agent" }))
			.payload;
		const b = (await request(claude, [readTool, grepTool, otherRoleTool], { ...options, toolCacheBoundary: "skill" }))
			.payload;
		expect(toolLayout(a)).toEqual(["read", "grep", "|", "agent"]);
		expect(toolLayout(b)).toEqual(["read", "grep", "|", "skill"]);
		// Not vacuous: the role tools differ, so a point on the last tool would differ too.
		expect(JSON.stringify(a.toolConfig?.tools)).not.toBe(JSON.stringify(b.toolConfig?.tools));
		expect(JSON.stringify(a.toolConfig?.tools.slice(0, 3))).toBe(JSON.stringify(b.toolConfig?.tools.slice(0, 3)));
		// The shared-tool point takes the base block's slot: only the session block keeps one, within four.
		expect(a.system?.filter((block) => block.cachePoint)).toHaveLength(1);
		expect(points(a).length).toBeLessThanOrEqual(4);
		expect(points(a)).toHaveLength(points(b).length);
	});

	it("keeps the base block's point beside the shared-tool point when the prompt is one block", async () => {
		const { payload } = await request(claude, [readTool, roleTool], {
			cacheRetention: "long",
			toolCacheBoundary: "agent",
		});
		expect(toolLayout(payload)).toEqual(["read", "|", "agent"]);
		expect(payload.system?.filter((block) => block.cachePoint)).toHaveLength(1);
		expect(points(payload).length).toBeLessThanOrEqual(4);
	});

	it("ignores a tool boundary that names the first tool or no tool", async () => {
		for (const toolCacheBoundary of ["read", "missing", undefined]) {
			const { payload } = await request(claude, [readTool, roleTool], { cacheRetention: "long", toolCacheBoundary });
			expect(toolLayout(payload)).toEqual(["read", "agent", "|"]);
		}
	});

	it("sends no tool point on Nova, whose tools take none, and keeps its system point", async () => {
		const { payload } = await request(nova, [readTool, grepTool, roleTool], {
			cacheRetention: "short",
			instructionCacheBoundary: "project_context",
			toolCacheBoundary: "agent",
		});
		expect(toolLayout(payload)).toEqual(["read", "grep", "agent"]);
		expect(payload.system?.filter((block) => block.cachePoint).length).toBeGreaterThan(0);
	});
});

describe("Bedrock application inference profile without a recognized model", () => {
	const profile = (suffix: string, name: string) => ({
		...claude,
		id: `arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/${suffix}`,
		name,
	});
	const notices = (reply: { diagnostics?: { type: string; details?: Record<string, unknown> }[] }) =>
		(reply.diagnostics ?? []).filter((diagnostic) => diagnostic.type === "cache_unavailable");

	it("sends no cache points and says so once, with the fix", async () => {
		const model = profile("opaque1", "team-default");
		const first = await request(model, [readTool], { cacheRetention: "long" });
		expect(points(first.payload)).toEqual([]);
		expect(notices(first.reply)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ reason: "unrecognized_inference_profile", model: model.id }),
			}),
		]);
		expect(String(notices(first.reply)[0].details?.fix)).toContain("name");
		const second = await request(model, [readTool], { cacheRetention: "long" });
		expect(notices(second.reply)).toEqual([]);
	});

	it("says nothing when the name names the model, caching is off or the user forced cache points", async () => {
		const named = await request(profile("named1", "Claude Opus 4.8"), [readTool], { cacheRetention: "long" });
		expect(points(named.payload).length).toBeGreaterThan(0);
		expect(notices(named.reply)).toEqual([]);
		const off = await request(profile("off1", "team-default"), [readTool], {
			cacheRetention: "none",
			instructionCacheRetention: "none",
		});
		expect(notices(off.reply)).toEqual([]);
		const target = profile("forced1", "team-default");
		const env = { AWS_BEDROCK_FORCE_CACHE: "1" };
		expect(resolveModelCapabilities(target, env).cache).toEqual({ mechanism: "markers", lifetimes: { short: 300 } });
		expect(resolveModelCapabilities(target, { AWS_BEDROCK_FORCE_CACHE: "0" }).cache.lifetimes).toEqual({});
		const forced = await request(target, [readTool], {
			cacheRetention: "long",
			env,
		});
		const forcedPoints = points(forced.payload);
		expect(forcedPoints.length).toBeGreaterThan(0);
		expect(forcedPoints.every((point) => point.cachePoint?.ttl === undefined)).toBe(true);
		const declared = { ...target, compat: { ...target.compat, supportsLongCacheRetention: true } };
		expect(resolveModelCapabilities(declared, env).cache.lifetimes.long).toBe(3600);
		expect(
			points((await request(declared, [readTool], { cacheRetention: "long", env })).payload).some(
				(point) => point.cachePoint?.ttl === "1h",
			),
		).toBe(true);
		expect(notices(forced.reply)).toEqual([]);
	});
});
