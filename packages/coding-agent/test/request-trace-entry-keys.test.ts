import {
	type AssistantMessage,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { branchTraceSource, withRequestTrace } from "../src/core/agent-session/request-trace.ts";

const newReply = () => ({ role: "assistant", content: [], stopReason: "stop" }) as unknown as AssistantMessage;
const model = { api: "anthropic-messages" } as never;

const first = { role: "user", content: "alpha", timestamp: 1 };
const second = { role: "assistant", content: [{ type: "text", text: "beta" }], timestamp: 2 };
const third = { role: "user", content: "gamma", timestamp: 3 };
const conversation = [first, second, third];
const entries = conversation.map((message, i) => ({ type: "message", id: `e${i}`, message }));
const wire = (messages: unknown[]) => ({ model: "m", max_tokens: 1, messages });
const wireOf = (m: { role: string; content: unknown }) => ({ role: m.role, content: m.content });

async function keysFor(hook?: (payload: { messages: unknown[] }) => unknown): Promise<(string | undefined)[]> {
	const payload = wire(conversation.map(wireOf));
	const stream = withRequestTrace<SimpleStreamOptions>(
		{ onPayload: hook ? (p: unknown) => hook(p as { messages: unknown[] }) : undefined },
		(options) => {
			const source = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.(payload, model);
				source.end(newReply());
			})();
			return source;
		},
		branchTraceSource(conversation, entries),
	);
	const message = await stream.result();
	return message.requestTrace!.layers.filter((l) => l.kind === "message").map((l) => l.entryKey);
}

describe("request trace entry keys", () => {
	it("stamps each unmodified message with its session entry", async () => {
		expect(await keysFor()).toEqual(["message:e0", "message:e1", "message:e2"]);
		expect(await keysFor(() => undefined)).toEqual(["message:e0", "message:e1", "message:e2"]);
	});

	it("leaves messages a hook swapped unstamped, and keeps the untouched one", async () => {
		const keys = await keysFor((p) => wire([p.messages[1], p.messages[0], p.messages[2]]));
		expect(keys).toEqual([undefined, undefined, "message:e2"]);
	});

	it("does not stamp a message that is not a session entry's own object", async () => {
		const stream = withRequestTrace<SimpleStreamOptions>(
			{},
			(options) => {
				const source = createAssistantMessageEventStream();
				void Promise.resolve(options.onPayload?.(wire(conversation.map(wireOf)), model)).then(() =>
					source.end(newReply()),
				);
				return source;
			},
			branchTraceSource(conversation, [{ type: "message", id: "x", message: { ...first } }]),
		);
		const message = await stream.result();
		expect(message.requestTrace!.layers.some((l) => l.entryKey)).toBe(false);
	});
});
