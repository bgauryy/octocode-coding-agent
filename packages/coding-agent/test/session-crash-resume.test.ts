import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { transformMessages } from "../../ai/src/api/transform-messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-crash-resume-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A process killed while a batch of three tool calls runs leaves the assistant message and the results that finished
 * on disk, and nothing for the rest. The resumed session must send the provider a transcript it accepts: one result
 * for every call, right after the assistant message, the finished one unchanged and none twice.
 */
it("sends one result per tool call after a process died inside a tool batch", () => {
	const crashed = SessionManager.create(dir, dir);
	crashed.appendMessage({ role: "user", content: "run three", timestamp: 1 });
	crashed.appendMessage({
		role: "assistant",
		content: ["a", "b", "c"].map((id) => ({ type: "toolCall" as const, id, name: "bash", arguments: { id } })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	});
	crashed.appendMessage({
		role: "toolResult",
		toolCallId: "b",
		toolName: "bash",
		content: [{ type: "text", text: "b finished" }],
		isError: false,
		timestamp: 3,
	});
	const file = crashed.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");

	// A new process: nothing of the old manager is reused.
	const resumed = SessionManager.open(file, dir);
	resumed.appendMessage({ role: "user", content: "continue", timestamp: 4 });
	const sent = transformMessages(resumed.buildSessionContext().messages as Message[], model);

	expect(sent.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"toolResult",
		"toolResult",
		"toolResult",
		"user",
	]);
	const results = sent.flatMap((message) => (message.role === "toolResult" ? [message] : []));
	expect(results.map((result) => result.toolCallId).sort()).toEqual(["a", "b", "c"]);
	const finished = results.find((result) => result.toolCallId === "b");
	expect(finished).toMatchObject({ isError: false, content: [{ type: "text", text: "b finished" }] });
	for (const id of ["a", "c"]) expect(results.find((result) => result.toolCallId === id)?.isError).toBe(true);
});
