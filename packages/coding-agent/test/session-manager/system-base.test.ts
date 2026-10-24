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
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
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
