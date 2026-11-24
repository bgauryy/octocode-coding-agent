import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockCacheProfile } from "../src/api/bedrock-converse-stream/model-match.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Message, Model, StreamOptions, SystemMessage, Tool } from "../src/types.ts";
import { CACHE_PROFILES, planCacheMarkers, type CacheLayout } from "../src/utils/cache-profiles.ts";
import { splitSystemMessageIntoBlocks } from "../src/utils/instruction-split.ts";
import { normalizeContext, type TranscriptContext } from "../src/utils/transcript.ts";
import { bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";

const SECTIONS = {
	work: "<work>w</work>",
	project_context: "<project>AGENTS</project>",
	cwd: "<cwd>/w</cwd>",
};
const BOUNDARIES = {
	instructionCacheBoundary: "work",
	instructionWorkspaceBoundary: "project_context",
	instructionVolatileBoundary: "cwd",
	toolCacheBoundary: "write",
} satisfies StreamOptions;
const tools: Tool[] = ["read", "write", "backlog"].map((name) => ({
	name,
	description: name,
	parameters: Type.Object({ path: Type.String() }),
}));
const history: Message[] = [
	{ role: "user", content: "one", timestamp: 1 },
	{
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	},
	{ role: "user", content: "two", timestamp: 3 },
];

function context(sections: Record<string, string> = SECTIONS): TranscriptContext {
	const base = normalizeContext({ systemPrompt: "unused", messages: history, tools });
	const [initial, ...rest] = base.messages;
	const system: SystemMessage = { role: "system", content: "Base", sections, timestamp: 0 };
	return { messages: [{ ...(initial as SystemMessage), ...system }, ...rest] } as TranscriptContext;
}

class Captured extends Error {}

beforeEach(() => {
	vi.stubEnv("OCTOCODE_CACHE_RETENTION", undefined);
	vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", undefined);
});
afterEach(() => vi.unstubAllEnvs());

interface AnthropicBody {
	system?: { text: string; cache_control?: { ttl?: string } }[];
	tools?: { name: string; cache_control?: unknown }[];
	messages: { content: string | { cache_control?: unknown }[] }[];
}

async function anthropicBody(
	options: StreamOptions = {},
	sections: Record<string, string> = SECTIONS,
): Promise<AnthropicBody> {
	const model: Model<"anthropic-messages"> = getBuiltinModel("anthropic", "claude-haiku-4-5");
	let body: AnthropicBody | undefined;
	await anthropicStream(model, context(sections), {
		apiKey: "test",
		...options,
		onPayload: (value) => {
			body = structuredClone(value) as AnthropicBody;
			throw new Captured();
		},
	}).result();
	if (!body) throw new Error("payload not captured");
	return body;
}

const anthropicMarkers = (body: AnthropicBody) => ({
	system: body.system?.map((block) => block.cache_control !== undefined),
	tools: body.tools?.map((tool) => tool.cache_control !== undefined),
	messages: body.messages.map(
		(message) => Array.isArray(message.content) && message.content.some((part) => part.cache_control !== undefined),
	),
});

describe("splitSystemMessageIntoBlocks with a workspace boundary", () => {
	it("ends a block before the workspace section and keeps the volatile block last", () => {
		const message: SystemMessage = { role: "system", content: "Base", sections: SECTIONS, timestamp: 0 };
		const split = splitSystemMessageIntoBlocks(message, "work", "cwd", "project_context");
		expect(split?.cached).toHaveLength(3);
		expect(split?.cached[1]).toContain("<work>");
		expect(split?.cached[1]).not.toContain("AGENTS");
		expect(split?.cached[2]).toContain("AGENTS");
		expect(split?.volatile).toContain("<cwd>");
	});
});

describe("planCacheMarkers", () => {
	const layout: CacheLayout = { instructionBlocks: 3, instructions: true, history: true, tools: 3, toolBoundary: true };

	it("Anthropic: tools boundary, shared block and two history turns; the workspace block yields", () => {
		expect(planCacheMarkers(CACHE_PROFILES.anthropic, { ...layout, workspaceBlock: true })).toEqual({
			blocks: [false, true, false],
			tool: true,
			history: 2,
		});
	});
	it("gives the workspace block only a slot nothing else needs", () => {
		const plan = planCacheMarkers(CACHE_PROFILES.anthropic, { ...layout, workspaceBlock: true, history: false });
		expect(plan).toEqual({ blocks: [false, true, true], tool: true, history: 0 });
	});
	it("without project instructions the budget goes to the history", () => {
		const plan = planCacheMarkers(CACHE_PROFILES.anthropic, { ...layout, instructionBlocks: 2 });
		expect(plan).toEqual({ blocks: [false, true], tool: true, history: 2 });
	});
	it("Nova: no tools marker, system and messages only", () => {
		const plan = planCacheMarkers(CACHE_PROFILES.bedrockNova, { ...layout, toolBoundary: false });
		expect(plan.tool).toBe(false);
		expect(plan.blocks).toEqual([true, true, true]);
	});
	it("implicit and none profiles place nothing", () => {
		for (const profile of [CACHE_PROFILES.bedrockOther, CACHE_PROFILES.none])
			expect(planCacheMarkers(profile, layout)).toEqual({ blocks: [false, false, false], tool: false, history: 0 });
	});
	it("retention none turns instruction and history markers off", () => {
		const plan = planCacheMarkers(CACHE_PROFILES.anthropic, { ...layout, instructions: false, history: false });
		expect(plan).toEqual({ blocks: [false, false, false], tool: false, history: 0 });
	});
});

describe("Anthropic request body", () => {
	it("marks the tools boundary, the shared block and the last two turns; project_context is cut but unmarked", async () => {
		const body = await anthropicBody(BOUNDARIES);
		expect(body.system).toHaveLength(4);
		expect(anthropicMarkers(body)).toEqual({
			system: [false, true, false, false],
			// The boundary names the first role-variant tool; the marker sits on the tool before it.
			tools: [true, false, false],
			messages: [true, false, true],
		});
		// The shared marker sits before project_context, so it caches no workspace text.
		expect(body.system?.[1].text).not.toContain("AGENTS");
	});
	it("marks the shared base when the prompt is only base + project_context", async () => {
		const sections = { project_context: SECTIONS.project_context, cwd: SECTIONS.cwd };
		const body = await anthropicBody(
			{
				instructionWorkspaceBoundary: "project_context",
				instructionVolatileBoundary: "cwd",
				toolCacheBoundary: "write",
			},
			sections,
		);
		expect(body.system).toHaveLength(3);
		expect(anthropicMarkers(body)).toEqual({
			system: [true, false, false],
			tools: [true, false, false],
			messages: [true, false, true],
		});
	});
	it("gives the budget back to the history when the prompt has no project_context", async () => {
		const sections = { work: SECTIONS.work, cwd: SECTIONS.cwd };
		const body = await anthropicBody({ ...BOUNDARIES }, sections);
		expect(body.system).toHaveLength(3);
		expect(JSON.stringify(anthropicMarkers(body))).toBe(
			JSON.stringify({ system: [false, true, false], tools: [true, false, false], messages: [true, false, true] }),
		);
	});
	it("sends 5m markers by default and 1h on every instruction marker with long instruction retention", async () => {
		const short = await anthropicBody(BOUNDARIES);
		expect(short.system?.filter((block) => block.cache_control).map((block) => block.cache_control?.ttl)).toEqual([
			undefined,
		]);
		const long = await anthropicBody({ ...BOUNDARIES, instructionCacheRetention: "long" });
		expect(long.system?.filter((block) => block.cache_control).map((block) => block.cache_control?.ttl)).toEqual([
			"1h",
		]);
	});
	it("sends no marker with retention none", async () => {
		const body = await anthropicBody({ ...BOUNDARIES, cacheRetention: "none" });
		expect(JSON.stringify(body)).not.toContain("cache_control");
	});
});

interface BedrockBody {
	system?: { text?: string; cachePoint?: { ttl?: string } }[];
	toolConfig?: { tools: { cachePoint?: unknown }[] };
	messages: { content: { cachePoint?: unknown }[] }[];
}

const base = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
async function bedrockBody(model: Model<"bedrock-converse-stream">, options: StreamOptions = {}): Promise<BedrockBody> {
	let body: BedrockBody | undefined;
	await bedrockStream(model, context(), {
		env: {},
		apiKey: "test",
		fetch: async () => bedrockResponse(bedrockTextEvents),
		...options,
		onPayload: (value) => {
			body = structuredClone(value) as BedrockBody;
			return value;
		},
	}).result();
	if (!body) throw new Error("payload not captured");
	return body;
}
const pointCount = (body: BedrockBody) =>
	(body.system ?? []).filter((block) => block.cachePoint).length +
	(body.toolConfig?.tools ?? []).filter((tool) => tool.cachePoint).length +
	body.messages.flatMap((message) => message.content).filter((block) => block.cachePoint).length;

describe("Bedrock request bodies per profile", () => {
	it("Claude: the Anthropic layout with cachePoint", async () => {
		expect(bedrockCacheProfile(base)).toBe(CACHE_PROFILES.bedrockClaude);
		const body = await bedrockBody(base, BOUNDARIES);
		// Converse puts a cachePoint block after the text block it closes.
		const layout = body.system?.map((block) =>
			block.cachePoint
				? "point"
				: block.text?.includes("AGENTS")
					? "workspace"
					: block.text?.includes("<work>")
						? "shared"
						: block.text?.includes("<cwd>")
							? "volatile"
							: "base",
		);
		expect(layout).toEqual(["base", "shared", "point", "workspace", "volatile"]);
		expect(body.toolConfig?.tools.filter((tool) => tool.cachePoint)).toHaveLength(1);
		expect(pointCount(body)).toBe(4);
	});
	it("Nova: markers on system and messages, none on tools", async () => {
		const nova = { ...base, id: "amazon.nova-lite-v1:0", name: "Nova Lite" };
		expect(bedrockCacheProfile(nova)).toBe(CACHE_PROFILES.bedrockNova);
		const body = await bedrockBody(nova, BOUNDARIES);
		expect(body.toolConfig?.tools.some((tool) => tool.cachePoint)).toBe(false);
		expect(body.system?.some((block) => block.cachePoint)).toBe(true);
		expect(pointCount(body)).toBeLessThanOrEqual(4);
	});
	it.each([
		["zai.glm-4.7", "GLM 4.7"],
		["qwen.qwen3-coder-next", "Qwen3 Coder Next"],
	])("%s: not in AWS's explicit-caching table, so no cache point is sent", async (id, name) => {
		const model = { ...base, id, name };
		expect(bedrockCacheProfile(model)).toBe(CACHE_PROFILES.bedrockOther);
		const body = await bedrockBody(model, BOUNDARIES);
		expect(pointCount(body)).toBe(0);
	});
});
