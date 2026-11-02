import { describe, expect, it } from "vitest";
import { describeWork, unreportedWork } from "../../src/octocode/sessions/work.ts";

/** A start recorded in a transcript: the assistant's call with its arguments, then its result. */
const started = (call: string, name: string, args: Record<string, unknown>, details: Record<string, unknown>) => [
	{
		type: "message",
		timestamp: "2026-11-02T12:00:00Z",
		message: { role: "assistant", content: [{ type: "toolCall", id: call, name, arguments: args }] },
	},
	{
		type: "message",
		timestamp: "2026-11-02T12:00:00Z",
		message: { role: "toolResult", toolName: name, toolCallId: call, details },
	},
];

describe("running work keeps why it was started", () => {
	it("names a background job's command and the call's reason", () => {
		const entries = started(
			"c1",
			"bash",
			{ command: "yarn test", background: true, reason: "Run the suite\nwhile I edit the docs." },
			{ job: "bash-3" },
		);
		const [work] = unreportedWork(entries);
		expect(describeWork(work, false)).toBe('bash-3 (`yarn test`, why "Run the suite while I edit the docs.")');
	});

	it("names a subagent's goal and the reason its parent started it", () => {
		const entries = started(
			"c2",
			"agent",
			{ type: "task", goal: "Review the parser", task: "Review it", reason: "The diff touches the tokenizer." },
			{ id: "general-ab12", status: "background" },
		);
		const [work] = unreportedWork(entries);
		expect(describeWork(work)).toBe('general-ab12 (goal "Review the parser", why "The diff touches the tokenizer.")');
	});

	it("caps a long reason", () => {
		const entries = started("c3", "bash", { command: "make", reason: "x ".repeat(400) }, { job: "bash-1" });
		const text = describeWork(unreportedWork(entries)[0], false);
		expect(text.length).toBeLessThan(220);
		expect(text).toMatch(/…"\)$/);
	});
});
