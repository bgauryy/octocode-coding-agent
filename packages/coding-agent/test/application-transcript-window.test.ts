import type { ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";
import { describe, expect, it, vi } from "vitest";
import { transcriptHistory, transcriptWindow } from "../src/core/application/transcript-history.ts";

/** `count` tool calls: a tool row (even order) whose output is `size` characters, and its result message (odd order). */
function transcript(count: number, size: number) {
	const messages = new Map<string, ApplicationMessage>();
	const tools = new Map<string, ApplicationTool>();
	for (let i = 0; i < count; i++) {
		tools.set(`t${i}`, {
			toolCallId: `t${i}`,
			toolName: "read",
			text: "x".repeat(size),
			status: "completed",
			order: 2 * i,
		});
		messages.set(`m${i}`, {
			id: `m${i}`,
			role: "toolResult",
			text: `read ${i}`,
			complete: true,
			toolCallId: `t${i}`,
			order: 2 * i + 1,
		});
	}
	return { messages, tools };
}

/** Every tool the snapshot window and the history pages before it return, paging to the start. */
function reachableTools(messages: Map<string, ApplicationMessage>, tools: Map<string, ApplicationTool>) {
	const window = transcriptWindow(messages.values(), tools.values());
	const reached = new Set(window.tools.map((tool) => tool.toolCallId));
	let before: string | undefined = window.messages[0]?.id;
	for (let page = 0; page < 100 && before; page++) {
		const history = transcriptHistory(messages, tools, { before });
		for (const tool of history.tools) reached.add(tool.toolCallId);
		if (!history.hasMore) break;
		before = history.before;
	}
	return { window, reached };
}

describe("application snapshot transcript window", () => {
	it("bounds the work of trimming a long tool-only history and keeps the newest tools in order", () => {
		const { tools } = transcript(5000, 10);
		const original = Array.prototype.shift;
		let moved = 0;
		const shift = vi.spyOn(Array.prototype, "shift").mockImplementation(function (this: unknown[]) {
			moved += this.length;
			return original.call(this);
		});
		let window;
		try {
			window = transcriptWindow([], tools.values());
		} finally {
			shift.mockRestore();
		}
		expect(window.tools.map((tool) => tool.toolCallId)).toEqual([...tools.keys()].slice(-50));
		expect(tools.size).toBe(5000);
		expect(moved).toBeLessThanOrEqual(tools.size * 3);
	});
	it("carries every tool at or after its first message and leaves the older ones to the history pages", () => {
		// 40 calls with 5 KB outputs: 40 messages fit the message window, but not 40 tools in the old 50 KB tool budget.
		const { messages, tools } = transcript(40, 5000);
		const { window, reached } = reachableTools(messages, tools);
		const live = new Set(window.tools.map((tool) => tool.toolCallId));
		const first = window.messages[0].order!;
		const dropped = [...tools.values()].filter((tool) => tool.order! >= first && !live.has(tool.toolCallId));
		expect(dropped.map((tool) => tool.toolCallId)).toEqual([]);
		expect([...tools.keys()].filter((id) => !reached.has(id))).toEqual([]);
		// The messages whose tools could not fit moved out with them.
		expect(window.messages.length).toBeLessThan(40);
	});

	it("stays bounded in count and size, carrying older tools only with their messages", () => {
		const { messages, tools } = transcript(300, 2000);
		const { window, reached } = reachableTools(messages, tools);
		expect(window.messages.length).toBeLessThanOrEqual(50);
		expect(window.tools.length).toBeLessThanOrEqual(50);
		expect(JSON.stringify(window).length).toBeLessThanOrEqual(150000);
		const first = window.messages[0].order!;
		const calls = new Set(window.messages.map((message) => message.toolCallId));
		expect(window.tools.filter((tool) => tool.order! < first && !calls.has(tool.toolCallId))).toEqual([]);
		expect(reached.size).toBe(300);
	});

	it("keeps the newest message and its tool when tools are at their stored maximum", () => {
		const { messages, tools } = transcript(5, 59000);
		const { window, reached } = reachableTools(messages, tools);
		expect(window.messages.at(-1)?.id).toBe("m4");
		expect(window.tools.map((tool) => tool.toolCallId)).toContain("t4");
		expect(JSON.stringify(window).length).toBeLessThanOrEqual(150100);
		expect(reached.size).toBe(5);
	});

	it("past the last message, drops the oldest tools to stay within the budget", () => {
		const messages = new Map<string, ApplicationMessage>([
			["a", { id: "a", role: "assistant", text: "calling", complete: true, order: 0 }],
		]);
		const tools = new Map<string, ApplicationTool>();
		for (let i = 1; i <= 5; i++)
			tools.set(`t${i}`, {
				toolCallId: `t${i}`,
				toolName: "read",
				text: "x".repeat(59000),
				status: "running",
				order: i,
			});
		const window = transcriptWindow(messages.values(), tools.values());
		expect(window.messages.map((message) => message.id)).toEqual(["a"]);
		expect(window.tools.map((tool) => tool.toolCallId)).toEqual(["t4", "t5"]);
	});
});
