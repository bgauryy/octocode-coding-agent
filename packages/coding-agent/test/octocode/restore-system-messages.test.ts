/**
 * `context` handlers see the conversation only; Octocode puts the system messages back (B321). The leading message must
 * stay as it was sent and later updates must stay between the same neighbours, so a handler that edits a result does not
 * fold the updates into the head and rewrite the provider's cached prefix.
 */
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { restoreSystemMessages } from "../../src/core/features/runner/event-handlers.ts";

const system = (sections: Record<string, string | null>, timestamp: number, extra: object = {}): AgentMessage => ({
	role: "system",
	content: "",
	sections,
	timestamp,
	...extra,
});
const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const result = (id: string, text: string, timestamp: number): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "web",
	content: [{ type: "text", text }],
	isError: false,
	timestamp,
});
const assistant = (timestamp: number): AgentMessage =>
	({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp,
	}) as AgentMessage;

const head = system({ environment: "Date: 2026-11-07", skills: "s" }, 0, { toolsAdded: [] });
const today = system({ environment: "Date: 2026-11-08" }, 9);
const visibleOf = (messages: AgentMessage[]) => messages.filter((message) => message.role !== "system");
const roles = (messages: AgentMessage[]) => messages.map((message) => message.role);

describe("restoreSystemMessages", () => {
	it("keeps every system message in place when the handler changed nothing", () => {
		const current = [head, user("a", 1), today, user("b", 2)];
		const visible = visibleOf(current);
		expect(restoreSystemMessages(current, visible, visible.slice())).toBe(current);
	});

	it("keeps the head and each update where it was when a handler replaces a message", () => {
		const current = [head, user("a", 1), result("c1", "page", 2), assistant(3), today, user("b", 4)];
		const visible = visibleOf(current);
		const fenced = { ...result("c1", "<fence>page</fence>", 2) };
		const returned = [visible[0], fenced, visible[2], visible[3]];
		const restored = restoreSystemMessages(current, visible, returned);
		expect(restored[0]).toBe(head);
		expect(roles(restored)).toEqual(["system", "user", "toolResult", "assistant", "system", "user"]);
		expect(restored[2]).toBe(fenced);
		expect(restored[4]).toBe(today);
		expect(getCurrentSystemMessage(restored)?.sections?.environment).toBe("Date: 2026-11-08");
	});

	it("places an update before the next message that survives when its neighbours were dropped", () => {
		const current = [head, user("a", 1), assistant(2), today, user("b", 3), assistant(4)];
		const visible = visibleOf(current);
		const restored = restoreSystemMessages(current, visible, [visible[2], visible[3]]);
		expect(restored[0]).toBe(head);
		expect(roles(restored)).toEqual(["system", "system", "user", "assistant"]);
		expect(restored[1]).toBe(today);
	});

	it("keeps an update after everything when the messages before it survive and the later ones were dropped", () => {
		const current = [head, user("a", 1), today, user("b", 3)];
		const visible = visibleOf(current);
		const restored = restoreSystemMessages(current, visible, [visible[0]]);
		expect(roles(restored)).toEqual(["system", "user", "system"]);
	});

	it("keeps a system message the handler wrote itself where the handler put it", () => {
		const current = [head, user("a", 1), today, user("b", 2)];
		const visible = visibleOf(current);
		const own = system({ extra: "from the extension" }, 5);
		const restored = restoreSystemMessages(current, visible, [visible[0], own, visible[1]]);
		expect(restored[0]).toBe(head);
		expect(restored.indexOf(own)).toBe(2);
		expect(restored.indexOf(today)).toBeGreaterThan(restored.indexOf(own));
	});

	it("matches a surviving message by identity before a lookalike with the same role and time", () => {
		const a = user("a", 5);
		const b = user("b", 5);
		const c = assistant(6);
		const later = system({ work: "B2" }, 10);
		const current = [head, a, today, b, later, c];
		const restored = restoreSystemMessages(current, visibleOf(current), [b, c]);
		expect(restored).toEqual([head, today, b, later, c]);
	});

	it("tells edited tool results of one moment apart by their tool call", () => {
		const first = result("c1", "one", 7);
		const second = result("c2", "two", 7);
		const current = [head, user("a", 1), first, today, second];
		const visible = visibleOf(current);
		const fencedSecond = { ...result("c2", "<fence>two</fence>", 7) };
		const restored = restoreSystemMessages(current, visible, [visible[0], fencedSecond]);
		expect(restored).toEqual([head, visible[0], today, fencedSecond]);
	});

	it("keeps messages a handler inserted where it put them, before a trailing update", () => {
		const current = [head, user("a", 1), today];
		const visible = visibleOf(current);
		const inserted = user("reminder", 50);
		const restored = restoreSystemMessages(current, visible, [visible[0], inserted]);
		expect(restored).toEqual([head, visible[0], inserted, today]);
	});

	it("folds the system messages into one leading message when the transcript has no leading one", () => {
		const current = [user("a", 1), today, user("b", 2)];
		const visible = visibleOf(current);
		const restored = restoreSystemMessages(current, visible, [visible[1]]);
		expect(roles(restored)).toEqual(["system", "user"]);
		expect(getCurrentSystemMessage(restored)?.sections?.environment).toBe("Date: 2026-11-08");
	});
});
