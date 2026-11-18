/**
 * A system-section update (a new day changes only `environment`) reaches the model after the history it already cached.
 * The session builds the context from its entries, the `context` handlers (Octocode's own fences web results in
 * every request) change the messages, and the adapter builds the Anthropic request: the request after the update must
 * start with the bytes of the request before it. No network.
 */
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { normalizeContext, type AssistantMessage, type Message, type SystemMessage } from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { SessionBus } from "../../src/core/features/bus/session-bus.ts";
import { dispatchContext } from "../../src/core/features/runner/emit-transforms.ts";
import type { FeatureRecord } from "../../src/core/features/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { requestMessages } from "../../src/octocode/compaction/thinking.ts";

type Payload = Record<string, any>;
class Captured extends Error {}

const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
const TOOLS = [{ name: "web", description: "Fetch a page", parameters: Type.Object({ url: Type.String() }) }];
const SECTIONS = {
	preamble: "<preamble>p</preamble>",
	project_context: "<project>project text</project>",
	skills: "<skills>s</skills>",
	environment: "<environment>Date: 2026-11-07</environment>",
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: 1,
	};
}

const head: SystemMessage = { role: "system", content: "", sections: SECTIONS, toolsAdded: TOOLS, timestamp: 0 };
const today: SystemMessage = {
	role: "system",
	content: "",
	sections: { environment: "<environment>Date: 2026-11-08</environment>" },
	timestamp: 9,
};
const toolTurn: Message[] = [
	{ role: "user", content: "Read the page", timestamp: 0 },
	reply([{ type: "toolCall", id: "c1", name: "web", arguments: { url: "https://example.test" } }], "toolUse"),
	{
		role: "toolResult",
		toolCallId: "c1",
		toolName: "web",
		content: [{ type: "text", text: "page body" }],
		isError: false,
		timestamp: 2,
	},
];

/** The context the session builds from its entries, as the agent loop reads it. */
function sessionMessages(entries: Message[]): AgentMessage[] {
	const session = SessionManager.inMemory(process.cwd());
	for (const entry of entries) session.appendMessage(entry);
	return session.buildSessionContext().messages;
}

/** The registered `context` handler Octocode installs: web and MCP results are fenced in every request. */
function withContextHandler(window?: (messages: AgentMessage[]) => AgentMessage[]): never {
	const handler = async (event: { messages: AgentMessage[] }) => ({
		messages: (window ?? ((messages) => messages))(requestMessages(event.messages, model, new Map())),
	});
	const feature = { path: "octocode", handlers: new Map([["context", [handler]]]) } as unknown as FeatureRecord;
	return {
		extensions: [feature],
		bus: new SessionBus([feature]),
		createContext: () => ({}),
		emitError: (error: unknown) => {
			throw error;
		},
	} as never;
}

async function request(entries: Message[], window?: (messages: AgentMessage[]) => AgentMessage[]): Promise<Payload> {
	const messages = await dispatchContext(withContextHandler(window), sessionMessages(entries));
	let payload: Payload | undefined;
	const result = await streamSimple(model, normalizeContext({ messages } as never), {
		apiKey: "sk-ant-api-test",
		sessionId: "update-session",
		maxRetries: 0,
		cacheRetention: "long",
		instructionCacheBoundary: "project_context",
		fetch: async () => Promise.reject(new Error("network is forbidden")),
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error(`payload not captured: ${result.errorMessage}`);
	return payload;
}

/** The messages without their breakpoints, which move to the newest message on every request by design. */
function unmarked(payload: Payload): string[] {
	return (payload.messages as Payload[]).map((message) => {
		const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		return JSON.stringify({
			...message,
			content: content.map(({ cache_control: _marker, ...block }: Payload) => block),
		});
	});
}

describe("a section update after a cached history (context handler changes the messages)", () => {
	it("fences the web result in every request, so the handler really changes the list", async () => {
		const payload = await request([head, ...toolTurn]);
		expect(JSON.stringify(payload.messages)).toContain("untrusted-");
	});

	const cases: [string, Message[]][] = [
		[
			"before the next user turn",
			[reply([{ type: "text", text: "Done." }], "stop"), today, { role: "user", content: "Next.", timestamp: 3 }],
		],
		["in a tool loop, after a tool result", [today]],
	];
	it.each(cases)("keeps the system blocks and every earlier message byte-identical (%s)", async (_name, tail) => {
		const before = await request([head, ...toolTurn]);
		const after = await request([head, ...toolTurn, ...tail]);
		expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
		const previous = unmarked(before);
		expect(unmarked(after).slice(0, previous.length)).toEqual(previous);
		expect(JSON.stringify(after.messages)).toContain("Date: 2026-11-08");
	});

	it("sends the update after the history even when a handler drops the oldest message", async () => {
		const dropOldest = (messages: AgentMessage[]) => messages.slice(1);
		const before = await request([head, ...toolTurn], dropOldest);
		const after = await request([head, ...toolTurn, today], dropOldest);
		expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
		const previous = unmarked(before);
		expect(unmarked(after).slice(0, previous.length)).toEqual(previous);
		expect(JSON.stringify(after.messages)).toContain("Date: 2026-11-08");
	});
});
