import {
	normalizeContext,
	type Api,
	type Context,
	type Model,
	type Provider,
	type SystemMessage,
} from "@octocodeai/octocode-ai";
import { stream as anthropicStream } from "@octocodeai/octocode-ai/api/anthropic-messages";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type ModelRequestHost,
	type RuntimeSimpleStreamOptions,
	streamChatModel,
	streamSimpleChatModel,
} from "../src/core/model-runtime/requests.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8000,
};

class Captured extends Error {}
type Payload = Record<string, { cache_control?: unknown }[] | { content: unknown }[]>;

/** The cache markers of a payload, by place: system blocks, tools, then the message content blocks. */
function markers(payload: Payload): unknown {
	const marks = (blocks: unknown) =>
		Array.isArray(blocks) ? blocks.map((b: { cache_control?: unknown }) => b.cache_control ?? null) : [];
	return {
		system: marks(payload.system),
		tools: marks(payload.tools),
		messages: (payload.messages as { content: unknown }[]).map((m) => marks(m.content)),
	};
}

function capturingHost(captured: Payload[]): ModelRequestHost {
	const send = (target: Model<Api>, context: Context, options: object) => {
		return anthropicStream(target as Model<"anthropic-messages">, normalizeContext(context), {
			...options,
			onPayload: (value: unknown) => {
				captured.push(structuredClone(value) as Payload);
				throw new Captured();
			},
		});
	};
	const provider = {
		stream: (target: Model<Api>, context: Context, options: object) => send(target, context, options),
		streamSimple: (target: Model<Api>, context: Context, options: object) => send(target, context, options),
	} as unknown as Provider;
	return {
		getProvider: () => provider,
		getAuth: async () => ({ auth: { apiKey: "sk-ant-api-test" }, env: {} }),
		getCachePolicy: () => ({ options: { cacheRetention: "short", instructionCacheRetention: "long" }, sources: {} }),
		resolveModel: async () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

function transcriptContext(): Context {
	const base = normalizeContext({
		systemPrompt: "Stable agent instructions",
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
		tools: [
			{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) },
			{ name: "grep", description: "Search", parameters: Type.Object({ pattern: Type.String() }) },
		],
	});
	const [initial, ...rest] = base.messages;
	const head = {
		...(initial as SystemMessage),
		content: "Stable agent instructions",
		sections: { docs: "<docs>d</docs>", project_context: "<project>p</project>" },
	};
	return { messages: [head, ...rest] };
}

async function request(
	run: (host: ModelRequestHost, options: RuntimeSimpleStreamOptions) => { result(): Promise<unknown> },
	roleVariantTools: ReadonlySet<string> | undefined,
): Promise<Payload> {
	const captured: Payload[] = [];
	await run(capturingHost(captured), { roleVariantTools })
		.result()
		.catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(captured).toHaveLength(1);
	return captured[0];
}

describe("chat requests send the same cache markers on every entry point", () => {
	for (const roleVariantTools of [undefined, new Set(["grep"])]) {
		it(`stream and streamSimple agree (roleVariantTools: ${roleVariantTools ? "set" : "unset"})`, async () => {
			const context = transcriptContext();
			const viaStream = await request(
				(host, options) => streamChatModel(host, model, context, undefined, options),
				roleVariantTools,
			);
			const viaSimple = await request(
				(host, options) => streamSimpleChatModel(host, model, context, options),
				roleVariantTools,
			);
			expect(markers(viaStream)).toEqual(markers(viaSimple));
			const flat = JSON.stringify(markers(viaStream));
			expect(flat).toContain('"ttl":"1h"');
		});
	}
});
