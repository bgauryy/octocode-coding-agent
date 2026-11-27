import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Message, Model, SystemMessage, Tool, TranscriptContext } from "../src/types.ts";

class PayloadCaptured extends Error {}

const model: Model<"mistral-conversations"> = {
	id: "mistral-large-latest",
	name: "Mistral Large",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://api.mistral.ai",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

const head: SystemMessage = {
	role: "system",
	content: "You are a coding agent.",
	sections: { mcp: "<mcp>none</mcp>" },
	toolsAdded: [{ name: "read", description: "read", parameters: Type.Object({}) }],
	timestamp: 1,
};
const update = (text: string, timestamp: number): SystemMessage => ({
	role: "system",
	content: "",
	sections: { mcp: text },
	timestamp,
});
const user = (content: string, timestamp: number): Message => ({ role: "user", content, timestamp });
const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
	role: "assistant",
	content,
	api: "mistral-conversations",
	provider: "mistral",
	model: "m",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	timestamp,
});
const call = assistant([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], 3);
const result: Message = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "read",
	content: [{ type: "text", text: "file" }],
	isError: false,
	timestamp: 4,
};

interface Payload {
	messages: { role: string; content: unknown }[];
	tools?: { function: { name: string; description: string } }[];
}

async function capture(
	start: (
		context: TranscriptContext,
		options: { apiKey: string; onPayload: (value: unknown) => never },
	) => AsyncIterable<unknown>,
	messages: Message[],
): Promise<Payload> {
	let payload: unknown;
	const events = start({ messages } as TranscriptContext, {
		apiKey: "test",
		onPayload: (value) => {
			payload = value;
			throw new PayloadCaptured();
		},
	});
	for await (const event of events) void event;
	return payload as Payload;
}

const run = (...messages: Message[]) =>
	capture((context, options) => streamMistral(model, context, options), [head, ...messages]);

const roles = (payload: Payload) => payload.messages.map((message) => message.role);

describe("Mistral system updates", () => {
	const base = [user("hello", 2), call, result];

	// An update after a tool result used to wait for the next user
	// message while the tools changed at once; it now reaches the leading prompt in the same request.
	it("folds an update that changes the prompt after a tool result into the leading prompt", async () => {
		const first = await run(...base);
		const later = await run(...base, update("<mcp>docs</mcp>", 5), assistant([{ type: "text", text: "ok" }], 6));
		expect(later.messages[0]).not.toEqual(first.messages[0]);
		expect(String(later.messages[0].content)).toContain("<mcp>docs</mcp>");
		expect(String(later.messages[0].content)).not.toContain("<mcp>none</mcp>");
		expect(roles(later)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
		expect(later.messages.slice(1, 4)).toEqual(first.messages.slice(1));
	});

	it("keeps the leading prompt when the update does not follow a tool result", async () => {
		const first = await run(user("hello", 2));
		const later = await run(
			user("hello", 2),
			update("<mcp>docs</mcp>", 3),
			assistant([{ type: "text", text: "hi" }], 4),
		);
		expect(later.messages[0]).toEqual(first.messages[0]);
	});

	// An update that changes nothing is still held and merged into the next user message.
	it("holds a no-op update that would follow a tool result and merges it into the next user message", async () => {
		const first = await run(...base);
		const held = await run(...base, update("<mcp>none</mcp>", 5));
		expect(held.messages).toEqual(first.messages);

		const merged = await run(
			...base,
			update("<mcp>none</mcp>", 5),
			assistant([{ type: "text", text: "ok" }], 6),
			user("next", 7),
		);
		expect(roles(merged)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
		const text = String(merged.messages[5].content);
		expect(text).toContain("[System update from the harness");
		expect(text).toContain("<mcp>none</mcp>");
		expect(text.endsWith("next")).toBe(true);
		expect(merged.messages.slice(0, 4)).toEqual(held.messages);
	});

	it("keeps block content of the receiving user message", async () => {
		const merged = await run(...base, update("<mcp>none</mcp>", 5), assistant([{ type: "text", text: "ok" }], 6), {
			role: "user",
			content: [{ type: "text", text: "next" }],
			timestamp: 7,
		});
		const content = merged.messages[5].content as { type: string; text: string }[];
		expect(content.map((chunk) => chunk.type)).toEqual(["text", "text"]);
		expect(content[0].text).toContain("<mcp>none</mcp>");
		expect(content[1].text).toBe("next");
	});

	it("sends an update before the next assistant turn when it does not follow a tool result", async () => {
		const payload = await run(
			user("hello", 2),
			update("<mcp>docs</mcp>", 3),
			assistant([{ type: "text", text: "hi" }], 4),
		);
		expect(roles(payload)).toEqual(["system", "user", "user", "assistant"]);
		expect(String(payload.messages[2].content)).toContain("<mcp>docs</mcp>");
	});

	it("never places a user message directly after a tool message", async () => {
		const payload = await run(
			...base,
			update("<mcp>one</mcp>", 5),
			assistant([{ type: "text", text: "ok" }], 6),
			update("<mcp>two</mcp>", 7),
		);
		const list = roles(payload);
		expect(list.some((role, index) => role === "user" && list[index - 1] === "tool")).toBe(false);
		expect(list).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
		expect(String(payload.messages[0].content)).toContain("<mcp>one</mcp>");
		expect(String(payload.messages[5].content)).toContain("<mcp>two</mcp>");
	});
});

// A contract update during a tool loop, as an MCP change delivers it.
describe("held contract update", () => {
	const tool = (name: string, description: string): Tool => ({ name, description, parameters: Type.Object({}) });
	const contractHead: SystemMessage = {
		role: "system",
		content: "You are a coding agent.",
		sections: { mcps: "<mcps>docs: search(old) fail()</mcps>" },
		toolsAdded: [tool("mcp__docs__search", "old"), tool("mcp__docs__fail", "x")],
		timestamp: 1,
	};
	// Adds `late`, withdraws `fail` and redescribes `search`.
	const contractUpdate: SystemMessage = {
		role: "system",
		content: "",
		sections: { mcps: "<mcps>docs: search(NEW) late(NEW)</mcps>", mcp_status: "- docs: connected; not declared: fail" },
		toolsRemoved: [{ name: "mcp__docs__fail" }, { name: "mcp__docs__search" }],
		toolsAdded: [tool("mcp__docs__search", "NEW"), tool("mcp__docs__late", "NEW")],
		timestamp: 5,
	};
	const toolCall = (id: string, timestamp: number) =>
		assistant([{ type: "toolCall", id, name: "mcp__docs__search", arguments: {} }], timestamp);
	const toolResult = (id: string, timestamp: number): Message => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "mcp__docs__search",
		content: [{ type: "text", text: `result ${id}` }],
		isError: false,
		timestamp,
	});
	// R0 before the change, R1 right after the tool result that the update follows, R2 one more tool round,
	// R3 after the final answer and the next user message.
	const requests = (change: SystemMessage): Message[][] => {
		const r0: Message[] = [contractHead, user("go", 2), toolCall("call_1", 3), toolResult("call_1", 4)];
		const r1 = [...r0, change];
		const r2 = [...r1, toolCall("call_2", 6), toolResult("call_2", 7)];
		const r3 = [...r2, assistant([{ type: "text", text: "done" }], 8), user("next", 9)];
		return [r0, r1, r2, r3];
	};
	const mistral = (messages: Message[]) =>
		capture((context, options) => streamMistral(model, context, options), messages);
	const completionsModel: Model<"openai-completions"> = {
		...model,
		id: "vendor/model",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
	};
	const toolNames = (payload: Payload) =>
		(payload.tools ?? []).map((entry) => `${entry.function.name}:${entry.function.description}`);
	const expectBytePrefixes = (payloads: Payload[]) => {
		for (let index = 1; index < payloads.length; index++) {
			const previous = JSON.stringify(payloads[index - 1].messages).slice(0, -1);
			expect(JSON.stringify(payloads[index].messages).startsWith(previous)).toBe(true);
		}
	};

	it("keeps consecutive payloads as byte prefixes on append routes", async () => {
		for (const supportsMidConvoSystemMessages of [false, true]) {
			const routeModel = { ...completionsModel, compat: { supportsMidConvoSystemMessages } };
			const payloads: Payload[] = [];
			for (const messages of requests(contractUpdate)) {
				payloads.push(await capture((context, options) => streamCompletions(routeModel, context, options), messages));
			}
			expectBytePrefixes(payloads);
			expect(JSON.stringify(payloads[1].messages)).toContain("search(NEW)");
		}
	});

	it("rewrites the Mistral head once for a held update, with the text and tools in the same request", async () => {
		const payloads: Payload[] = [];
		for (const messages of requests(contractUpdate)) payloads.push(await mistral(messages));
		const [r0, r1, r2, r3] = payloads;

		expect(r1.messages[0]).not.toEqual(r0.messages[0]);
		expect(r1.messages.slice(1)).toEqual(r0.messages.slice(1));
		expectBytePrefixes([r1, r2, r3]);
		for (const payload of [r1, r2, r3]) {
			const sent = JSON.stringify(payload.messages);
			expect(sent.includes("search(NEW)"), "updatedContractPresent").toBe(true);
			expect(sent).not.toContain("search(old)");
			expect(String(payload.messages[0].content)).toContain("not declared: fail");
			expect(toolNames(payload)).toEqual(["mcp__docs__search:NEW", "mcp__docs__late:NEW"]);
		}
		expect(roles(r3)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user"]);
	});

	it("keeps the Mistral head for a held tool-only or unchanged update", async () => {
		const [r0] = requests(contractUpdate);
		const first = await mistral(r0);
		const toolOnly: SystemMessage = {
			role: "system",
			content: "",
			toolsAdded: [tool("mcp__docs__late", "NEW")],
			timestamp: 5,
		};
		const unchanged: SystemMessage = {
			role: "system",
			content: "",
			sections: { ...contractHead.sections },
			timestamp: 5,
		};
		for (const change of [toolOnly, unchanged]) {
			const payload = await mistral(requests(change)[1]);
			expect(payload.messages).toEqual(first.messages);
		}
		expect(toolNames(await mistral(requests(toolOnly)[1]))).toContain("mcp__docs__late:NEW");
	});

	it("never sends an older update after a newer one", async () => {
		const version = (text: string, timestamp: number): SystemMessage => ({
			role: "system",
			content: "",
			sections: { mcps: `<mcps>${text}</mcps>` },
			timestamp,
		});
		// v2 arrives between turns and travels as user text; v3 follows a tool result and is folded.
		const messages: Message[] = [
			contractHead,
			user("go", 2),
			assistant([{ type: "text", text: "ok" }], 3),
			version("MCPS v2", 4),
			user("go on", 5),
			toolCall("call_1", 6),
			toolResult("call_1", 7),
		];
		const before = await mistral(messages);
		expect(String(before.messages[3].content)).toContain("MCPS v2");

		const after = await mistral([...messages, version("MCPS v3", 8)]);
		const versions = after.messages.flatMap((message) => JSON.stringify(message).match(/MCPS v\d/g) ?? []);
		expect(versions).toEqual(["MCPS v3"]);
		expect(String(after.messages[0].content)).toContain("MCPS v3");
	});

	// The host may append an update while tools run, so it can sit before the result or between parallel results.
	const parallelCall = assistant(
		[
			{ type: "toolCall", id: "call_a", name: "mcp__docs__search", arguments: {} },
			{ type: "toolCall", id: "call_b", name: "mcp__docs__search", arguments: {} },
		],
		3,
	);
	const rounds: [string, (change?: SystemMessage) => Message[]][] = [
		[
			"between a tool call and its result",
			(change) => [toolCall("call_1", 3), ...(change ? [change] : []), toolResult("call_1", 4)],
		],
		[
			"between parallel tool results",
			(change) => [parallelCall, toolResult("call_a", 4), ...(change ? [change] : []), toolResult("call_b", 4)],
		],
	];
	const around = (round: Message[]): Message[][] => {
		const r1: Message[] = [contractHead, user("go", 2), ...round];
		const r2 = [...r1, toolCall("call_2", 6), toolResult("call_2", 7)];
		const r3 = [...r2, assistant([{ type: "text", text: "done" }], 8), user("next", 9)];
		return [r1, r2, r3];
	};

	describe.each(rounds)("an update placed %s", (_name, round) => {
		it("is folded into the Mistral head with the text and tools in the same request", async () => {
			const [r0] = around(round());
			const before = await mistral(r0);
			const payloads: Payload[] = [];
			for (const messages of around(round(contractUpdate))) payloads.push(await mistral(messages));
			const [r1] = payloads;

			expect(r1.messages[0]).not.toEqual(before.messages[0]);
			expect(r1.messages.slice(1)).toEqual(before.messages.slice(1));
			expectBytePrefixes(payloads);
			for (const payload of payloads) {
				const sent = JSON.stringify(payload.messages);
				expect(sent.includes("search(NEW)"), "updatedContractPresent").toBe(true);
				expect(sent).not.toContain("search(old)");
				expect(String(payload.messages[0].content)).toContain("not declared: fail");
				expect(toolNames(payload)).toEqual(["mcp__docs__search:NEW", "mcp__docs__late:NEW"]);
			}
		});

		it("keeps the Mistral head for a tool-only or unchanged update", async () => {
			const before = await mistral(around(round())[0]);
			const toolOnly: SystemMessage = {
				role: "system",
				content: "",
				toolsAdded: [tool("mcp__docs__late", "NEW")],
				timestamp: 5,
			};
			const unchanged: SystemMessage = {
				role: "system",
				content: "",
				sections: { ...contractHead.sections },
				timestamp: 5,
			};
			for (const change of [toolOnly, unchanged]) {
				expect((await mistral(around(round(change))[0])).messages).toEqual(before.messages);
			}
		});

		it("never sends an older update after a newer one", async () => {
			const version: SystemMessage = {
				role: "system",
				content: "",
				sections: { mcps: "<mcps>MCPS v2</mcps>" },
				timestamp: 1,
			};
			const latest: SystemMessage = { ...version, sections: { mcps: "<mcps>MCPS v3</mcps>" }, timestamp: 5 };
			const earlier: Message[] = [
				contractHead,
				user("go", 2),
				assistant([{ type: "text", text: "ok" }], 2),
				version,
				user("go on", 2),
			];
			const payload = await mistral([...earlier, ...round(latest)]);
			const versions = payload.messages.flatMap((message) => JSON.stringify(message).match(/MCPS v\d/g) ?? []);
			expect(versions).toEqual(["MCPS v3"]);
			expect(String(payload.messages[0].content)).toContain("MCPS v3");
		});

		it("keeps consecutive payloads as byte prefixes on an append route", async () => {
			const payloads: Payload[] = [];
			for (const messages of around(round(contractUpdate))) {
				payloads.push(
					await capture((context, options) => streamCompletions(completionsModel, context, options), messages),
				);
			}
			expectBytePrefixes(payloads);
			expect(String(payloads[0].messages[0].content)).not.toContain("search(NEW)");
			expect(JSON.stringify(payloads[0].messages)).toContain("search(NEW)");
		});
	});

	it("leaves the head alone when the model accepts mid-conversation system messages", async () => {
		const inPlace = { ...model, compat: { supportsMidConvoSystemMessages: true } };
		const [r0, r1] = requests(contractUpdate);
		const run = (messages: Message[]) =>
			capture((context, options) => streamMistral(inPlace, context, options), messages);
		const [before, after] = [await run(r0), await run(r1)];
		expect(after.messages[0]).toEqual(before.messages[0]);
		expect(roles(after).at(-1)).toBe("system");
	});
});
