import { describe, expect, it } from "vitest";
import { createEventLines } from "../src/modes/event-lines.ts";

/** A message whose `content` counts how often it is serialized. */
function counted(text: string) {
	const reads = { count: 0 };
	const message: Record<string, unknown> = { role: "assistant", stopReason: "stop", timestamp: 1 };
	Object.defineProperty(message, "content", {
		enumerable: true,
		get() {
			reads.count++;
			return [{ type: "text", text }];
		},
	});
	return { message, reads };
}

const run = (message: object, toolResults: object[] = []) => [
	{ type: "agent_start" },
	{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
	{ type: "message_end", message },
	...toolResults.map((result) => ({ type: "message_end", message: result })),
	{ type: "turn_end", message, toolResults },
	{ type: "agent_end", messages: [message, ...toolResults], willRetry: false },
];

describe("the JSON lines of wire events", () => {
	it("are byte for byte what JSON.stringify writes, a large message serialized once per run", () => {
		const reply = `"quoted" \\ ${"é✓ ".repeat(40_000)}`;
		const { message, reads } = counted(reply);
		const result = { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "r".repeat(70_000) }] };
		const lines = createEventLines();
		const written = run(message, [result]).map((event) => lines(event).join(""));
		const serialized = reads.count;
		reads.count = 0;
		const expected = run(message, [result]).map((event) => `${JSON.stringify(event)}\n`);
		expect(written).toEqual(expected);
		// message_end serialized it; turn_end and agent_end wrote the same text again.
		expect(serialized).toBe(1);
		expect(reads.count).toBe(3);
	});

	it("serializes a small message each time and forgets a run's messages at its end", () => {
		const small = counted("short");
		const lines = createEventLines();
		for (const event of run(small.message)) lines(event);
		expect(small.reads.count).toBe(3);

		const large = counted("x".repeat(100_000));
		for (const event of run(large.message)) lines(event);
		expect(large.reads.count).toBe(1);
		// After agent_end the next run's events serialize it again, as no event of that run has.
		lines({ type: "turn_end", message: large.message, toolResults: [] });
		expect(large.reads.count).toBe(2);
	});

	it("never matches a token against text that only resembles it", () => {
		const lines = createEventLines();
		const message = { role: "assistant", content: [{ type: "text", text: "y".repeat(70_000) }] };
		lines({ type: "message_end", message });
		const event = { type: "turn_end", message, toolResults: [], note: '"octocode-shared-x-0"' };
		expect(lines(event).join("")).toBe(`${JSON.stringify(event)}\n`);
	});

	it("writes a small event as one piece and a large message as a piece of its own", () => {
		const lines = createEventLines();
		const small = { role: "user", content: "hi" };
		expect(lines({ type: "message_end", message: small })).toHaveLength(1);
		const large = { role: "assistant", content: [{ type: "text", text: "z".repeat(70_000) }] };
		const pieces = lines({ type: "message_end", message: large });
		expect(pieces).toEqual(['{"type":"message_end","message":', JSON.stringify(large), "}\n"]);
		// turn_end writes the very string message_end wrote.
		expect(lines({ type: "turn_end", message: large, toolResults: [small] })[1]).toBe(pieces[1]);
	});
});
