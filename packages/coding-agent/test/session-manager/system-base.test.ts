import {
	collapseSystemMessages,
	getCurrentSystemMessage,
	getInitialSystemMessage,
	getSystemMessageText,
	type Message,
	normalizeContext,
	type SystemMessage,
	type Tool,
} from "@octocodeai/octocode-ai";
import { type Api, type Model, streamSimple } from "@octocodeai/octocode-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { CompactionEntry } from "../../src/core/session-manager.ts";

const tool = (name: string, description = name): Tool => ({
	name,
	description,
	parameters: Type.Object({ value: Type.String() }),
});

const head: SystemMessage = {
	role: "system",
	content: "Base prompt",
	sections: { rules: "<rules>one</rules>", cwd: "<cwd>/a</cwd>" },
	toolsAdded: [tool("read"), tool("bash")],
	timestamp: 0,
};

const update: SystemMessage = {
	role: "system",
	content: "Extra instruction",
	sections: { rules: "<rules>two</rules>", cwd: null, docs: "<docs>d</docs>" },
	toolsAdded: [tool("grep"), tool("bash", "changed")],
	toolsRemoved: [{ name: "read" }, { name: "bash" }],
	timestamp: 5,
};

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
}

/** A session whose request had a leading system message and one in-place update, then a compaction keeping the last turn. */
function compacted(withUpdate = true) {
	const session = SessionManager.inMemory("/tmp/system-base");
	session.appendMessage(head);
	session.appendMessage({ role: "user", content: "one", timestamp: 1 });
	session.appendMessage(assistant("a"));
	if (withUpdate) session.appendMessage(update);
	session.appendMessage({ role: "user", content: "two", timestamp: 2 });
	const keptId = session.appendMessage(assistant("b"));
	const before = session.buildSessionContext().messages;
	session.appendCompaction("summary", keptId, 100);
	return { session, before, keptId };
}

const compactionOf = (session: SessionManager): CompactionEntry =>
	session.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction")[0];

/** Fields providers read, without the timestamp (never sent). */
const state = (message: SystemMessage | undefined) =>
	message && {
		content: message.content,
		sections: Object.entries(message.sections ?? {}),
		tools: message.toolsAdded?.map((entry) => JSON.stringify(entry)),
	};

describe("compaction system base", () => {
	it("keeps the pre-compaction head first and replays to the folded state", () => {
		const { session, before } = compacted();
		const entry = compactionOf(session);
		expect(entry.systemBase).toEqual(head);
		const after = session.buildSessionContext().messages;
		expect(after[0]).toEqual(getInitialSystemMessage(before));
		expect(after.map((message) => message.role)).toEqual(["system", "compactionSummary", "system", "assistant"]);
		const replayed = getCurrentSystemMessage(after);
		expect(state(replayed)).toEqual(state(entry.systemMessage));
		expect(state(replayed)).toEqual(state(getCurrentSystemMessage(before)));
		// Without the field the entry projects to its folded state, as old session files do.
		const { systemBase: _omitted, ...legacy } = entry;
		const legacyContext = SessionManager.inMemory("/tmp/system-base-legacy", undefined, [
			{ type: "session", version: 3, id: "s", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			...session.getEntries().map((e) => (e.id === entry.id ? legacy : e)),
		]).buildSessionContext().messages;
		expect(legacyContext.map((message) => message.role)).toEqual(["system", "compactionSummary", "assistant"]);
		expect(state(getCurrentSystemMessage(legacyContext))).toEqual(state(replayed));
	});

	it("collapses to the same system text as without the base", () => {
		const { session, before } = compacted();
		const collapsed = collapseSystemMessages(
			normalizeContext({ messages: session.buildSessionContext().messages as Message[] }),
		);
		const reference = collapseSystemMessages(normalizeContext({ messages: before as Message[] }));
		expect(getSystemMessageText(collapsed.messages[0] as SystemMessage)).toBe(
			getSystemMessageText(reference.messages[0] as SystemMessage),
		);
		expect(state(collapsed.messages[0] as SystemMessage)).toEqual(state(reference.messages[0] as SystemMessage));
	});

	it("keeps the same base through a second compaction", () => {
		const { session } = compacted();
		session.appendMessage({ role: "user", content: "three", timestamp: 3 });
		session.appendMessage({
			role: "system",
			content: "",
			sections: { docs: "<docs>newer</docs>" },
			toolsAdded: [tool("find")],
			timestamp: 9,
		});
		const keptId = session.appendMessage(assistant("c"));
		const before = session.buildSessionContext().messages;
		session.appendCompaction("summary two", keptId, 100);
		const after = session.buildSessionContext().messages;
		expect(after[0]).toEqual(head);
		expect(state(getCurrentSystemMessage(after))).toEqual(state(getCurrentSystemMessage(before)));
		expect(getCurrentSystemMessage(after)?.toolsAdded?.map((entry) => entry.name)).toEqual(["grep", "bash", "find"]);
	});

	it("stores no base when nothing changed after the head", () => {
		const { session } = compacted(false);
		const entry = compactionOf(session);
		expect(entry.systemBase).toBeUndefined();
		expect(entry.systemMessage?.content).toBe("Base prompt");
		expect(session.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"system",
			"compactionSummary",
			"assistant",
		]);
	});

	it("keeps the state of entries without systemFold, which already holds the kept range", () => {
		const session = SessionManager.inMemory("/tmp/system-base-kept-legacy");
		session.appendMessage(head);
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const keptId = session.appendMessage(assistant("a"));
		session.appendMessage(update);
		session.appendCompaction("summary", keptId, 100);
		const entry = compactionOf(session);
		expect(entry.systemFold).toBe("summarized");
		const replayed = session.buildSessionContext().messages;
		expect(replayed.map((message) => message.role)).toEqual(["system", "compactionSummary", "assistant", "system"]);
		// An entry written before the field folded the whole branch: the kept update is not replayed again.
		const { systemFold: _omitted, ...legacy } = {
			...entry,
			systemMessage: getCurrentSystemMessage([head, update])!,
			systemBase: undefined,
		};
		const legacyContext = SessionManager.inMemory("/tmp/system-base-kept-legacy-2", undefined, [
			{ type: "session", version: 3, id: "s", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			...session.getEntries().map((e) => (e.id === entry.id ? legacy : e)),
		]).buildSessionContext().messages;
		expect(legacyContext.map((message) => message.role)).toEqual(["system", "compactionSummary", "assistant"]);
		expect(state(getCurrentSystemMessage(legacyContext))).toEqual(state(getCurrentSystemMessage(replayed)));
	});

	it("keeps the folded form when the change cannot be expressed as an update", () => {
		const session = SessionManager.inMemory("/tmp/system-base-rewrite");
		session.appendMessage(head);
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const keptId = session.appendMessage(assistant("a"));
		session.appendCompaction("summary", keptId, 100);
		const entry = compactionOf(session);
		// A hand-edited folded state whose text no longer extends the base text.
		const rewritten = {
			...entry,
			systemMessage: { ...entry.systemMessage!, content: "Other prompt" },
			systemBase: head,
		};
		const messages = SessionManager.inMemory("/tmp/system-base-rewrite-2", undefined, [
			{ type: "session", version: 3, id: "s", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			...session.getEntries().map((e) => (e.id === entry.id ? rewritten : e)),
		]).buildSessionContext().messages;
		expect(messages[0]).toMatchObject({ role: "system", content: "Other prompt" });
	});
});

/**
 * T19 (B431 A2.4): an MCP tool withdrawn inside the range a compaction keeps is replayed once; one withdrawn before the
 * boundary stays withdrawn without a stale addition. The session projection keeps the kept-range order. On the wire the
 * two paths differ: Anthropic (native mid-conversation system messages) keeps that order with one `tool_removal` block,
 * while Mistral sends only the current tools and places the status where its transcript fold puts it (see
 * `collapseSystemMessages` in packages/ai/src/utils/transcript.ts).
 */
describe("compaction boundary for prompt and tool changes", () => {
	const STATUS = "- docs: connected; not declared: mcp__docs__fail";
	const mcpHead: SystemMessage = {
		role: "system",
		content: "Base prompt",
		sections: { mcps: "<mcps>search, fail</mcps>" },
		toolsAdded: [tool("mcp__docs__search"), tool("mcp__docs__fail")],
		timestamp: 0,
	};
	const withdraw: SystemMessage = {
		role: "system",
		content: "",
		sections: { mcp_status: STATUS },
		toolsRemoved: [{ name: "mcp__docs__fail" }],
		timestamp: 4,
	};
	const call = {
		...assistant(""),
		content: [{ type: "toolCall" as const, id: "toolu_fail1", name: "mcp__docs__fail", arguments: { value: "x" } }],
		stopReason: "toolUse" as const,
	};
	const result = {
		role: "toolResult" as const,
		toolCallId: "toolu_fail1",
		toolName: "mcp__docs__fail",
		content: [{ type: "text" as const, text: "failed" }],
		isError: true,
		timestamp: 3,
	};

	/** A compacted session, then the next user message: `kept` starts the kept range. */
	function compactedContext(before: Message[], kept: Message[]) {
		const session = SessionManager.inMemory("/tmp/system-base-boundary");
		session.appendMessage(mcpHead);
		for (const message of before) session.appendMessage(message);
		const ids = kept.map((message) => session.appendMessage(message));
		session.appendCompaction("summary", ids[0], 100);
		session.appendMessage({ role: "user", content: "next", timestamp: 9 });
		return session.buildSessionContext().messages;
	}

	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const anthropic = {
		id: "claude-test",
		name: "Claude test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 200000,
		maxTokens: 1000,
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	} as Model<Api>;
	const mistral = {
		id: "mistral-large-latest",
		name: "Mistral Large",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 100000,
		maxTokens: 1000,
	} as Model<Api>;

	/** The request body the provider would send for the session context (captured before any network I/O). */
	async function payload(target: Model<Api>, messages: ReturnType<typeof compactedContext>): Promise<Wire> {
		let body: unknown;
		const outcome = await streamSimple(
			target,
			{ messages: convertToLlm(messages) },
			{
				apiKey: "test",
				onPayload: (request) => {
					body = request;
					throw new Error("payload captured");
				},
			},
		).result();
		expect(outcome.errorMessage).toContain("payload captured");
		return JSON.parse(JSON.stringify(body)) as Wire;
	}

	/** The parts of an Anthropic or Mistral request body these tests read. */
	interface WireBlock {
		type: string;
		text?: string;
		id?: string;
		name?: string;
		tool_use_id?: string;
		tool?: { name?: string };
	}
	interface WireMessage {
		role: string;
		content?: string | WireBlock[];
		toolCalls?: Array<{ id: string; function: { name: string } }>;
		toolCallId?: string;
		name?: string;
	}
	interface Wire {
		system?: string | WireBlock[];
		messages: WireMessage[];
		tools?: Array<{ name?: string; function?: { name: string } }>;
	}

	const blocks = (message: WireMessage): WireBlock[] => (Array.isArray(message.content) ? message.content : []);
	const text = (content: string | WireBlock[] | undefined) =>
		typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("\n");
	const occurrences = (content: string | WireBlock[] | undefined, part: string) => text(content).split(part).length - 1;
	/** Indexes of the request messages that satisfy `test`. */
	const where = (wire: Wire, test: (message: WireMessage) => boolean) =>
		wire.messages.flatMap((message, index) => (test(message) ? [index] : []));
	/** The one index `indexes` holds; fails when the marker is missing or repeated, so positions are never compared to -1. */
	const only = (indexes: number[]) => {
		expect(indexes).toHaveLength(1);
		return indexes[0];
	};
	/** Every place the status text appears: `system` for a top-level system field, else the message index. */
	const statusPlaces = (wire: Wire) => [
		...Array.from({ length: occurrences(wire.system, STATUS) }, () => "system" as const),
		...wire.messages.flatMap((message, index) =>
			Array.from({ length: occurrences(message.content, STATUS) }, () => index),
		),
	];
	const blocksOf = (wire: Wire, type: string) => wire.messages.flatMap(blocks).filter((block) => block.type === type);
	const declared = (wire: Wire) => (wire.tools ?? []).map((entry) => entry.function?.name ?? entry.name);
	/** Anthropic: the assistant message with the `tool_use` of the failing call, and the user message with its result. */
	const anthropicCall = (wire: Wire) =>
		where(
			wire,
			(message) =>
				message.role === "assistant" &&
				blocks(message).some((block) => block.type === "tool_use" && block.id === "toolu_fail1"),
		);
	const anthropicResult = (wire: Wire) =>
		where(
			wire,
			(message) =>
				message.role === "user" &&
				blocks(message).some((block) => block.type === "tool_result" && block.tool_use_id === "toolu_fail1"),
		);
	const anthropicRemoval = (wire: Wire) =>
		where(
			wire,
			(message) =>
				message.role === "system" &&
				blocks(message).some((block) => block.type === "tool_removal" && block.tool?.name === "mcp__docs__fail"),
		);
	/**
	 * Mistral: the assistant message whose `toolCalls` hold the failing call, and the tool message answering it. The
	 * adapter rewrites call ids to its own 9-character form, so the call is found by name and the result by that id.
	 */
	const mistralCall = (wire: Wire) =>
		where(
			wire,
			(message) =>
				message.role === "assistant" &&
				(message.toolCalls ?? []).some((entry) => entry.function.name === "mcp__docs__fail"),
		);
	const mistralResult = (wire: Wire, id: string | undefined) =>
		where(
			wire,
			(message) => message.role === "tool" && message.name === "mcp__docs__fail" && message.toolCallId === id,
		);
	const assistantSaying = (wire: Wire, words: string) =>
		where(wire, (message) => message.role === "assistant" && text(message.content).includes(words));

	it("replays a withdrawal inside the kept range once: after the kept call on Anthropic, folded into the head on Mistral", async () => {
		const messages = compactedContext(
			[{ role: "user", content: "go", timestamp: 1 }, assistant("hi")],
			[{ role: "user", content: "later", timestamp: 2 }, call, result, withdraw, assistant("done")],
		);
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"compactionSummary",
			"user",
			"assistant",
			"toolResult",
			"system",
			"assistant",
			"user",
		]);
		const removals = messages.filter((message) => message.role === "system" && message.toolsRemoved?.length);
		expect(removals).toHaveLength(1);
		expect(messages.indexOf(removals[0])).toBeGreaterThan(messages.indexOf(call));
		expect(getCurrentSystemMessage(messages)?.toolsAdded?.map((entry) => entry.name)).toEqual(["mcp__docs__search"]);

		// Anthropic keeps the kept-range order: call, result, one removal carrying the status, then the next answer.
		const wire = await payload(anthropic, messages);
		const toolUse = only(anthropicCall(wire));
		const toolResult = only(anthropicResult(wire));
		const removal = only(anthropicRemoval(wire));
		const done = only(assistantSaying(wire, "done"));
		expect(blocksOf(wire, "tool_removal")).toHaveLength(1);
		expect(blocksOf(wire, "tool_addition")).toHaveLength(0);
		expect(toolUse).toBeLessThan(toolResult);
		expect(toolResult).toBeLessThan(removal);
		expect(removal).toBeLessThan(done);
		expect(statusPlaces(wire)).toEqual([removal]);

		// Mistral declares only the current tools and has no removal block. The update follows a tool result, where the
		// adapter deliberately avoids placing a user message (whether the hosted API accepts that order is unverified),
		// so the transcript fold puts the current status in the head (system) message, before
		// the call it historically followed. That rewrites the head once for this update, which can reduce cache reuse: later
		// requests fold it the same way. Its historical placement is not kept on this path.
		const mistralWire = await payload(mistral, messages);
		expect(declared(mistralWire)).toEqual(["mcp__docs__search"]);
		expect(mistralWire.messages[0].role).toBe("system");
		const mistralToolCall = only(mistralCall(mistralWire));
		const callId = mistralWire.messages[mistralToolCall].toolCalls?.[0]?.id;
		expect(callId).toMatch(/^[a-zA-Z0-9]{9}$/);
		const mistralToolResult = only(mistralResult(mistralWire, callId));
		expect(mistralToolCall).toBeLessThan(mistralToolResult);
		expect(statusPlaces(mistralWire)).toEqual([0]);
		expect(where(mistralWire, (message) => message.role === "system")).toEqual([0]);
	});

	it("keeps a withdrawal before the boundary withdrawn, without a stale addition", async () => {
		const messages = compactedContext(
			[{ role: "user", content: "go", timestamp: 1 }, call, result, withdraw, assistant("done")],
			[{ role: "user", content: "later", timestamp: 5 }, assistant("ok")],
		);
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"compactionSummary",
			"system",
			"user",
			"assistant",
			"user",
		]);
		const wire = await payload(anthropic, messages);
		expect(anthropicCall(wire)).toEqual([]);
		const removal = only(anthropicRemoval(wire));
		expect(blocksOf(wire, "tool_removal")).toHaveLength(1);
		expect(blocksOf(wire, "tool_addition")).toHaveLength(0);
		expect(removal).toBeLessThan(only(assistantSaying(wire, "ok")));
		expect(statusPlaces(wire)).toEqual([removal]);

		const mistralWire = await payload(mistral, messages);
		expect(declared(mistralWire)).toEqual(["mcp__docs__search"]);
		expect(mistralCall(mistralWire)).toEqual([]);
		const places = statusPlaces(mistralWire);
		expect(places).toHaveLength(1);
		expect(places[0]).not.toBe("system");
		expect(places[0]).toBeLessThan(only(assistantSaying(mistralWire, "ok")));
	});
});
